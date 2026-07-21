import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// MediaPipe Hands loaded from CDN at runtime (avoids SSR + bundling headaches).
declare global {
  interface Window {
    Hands?: any;
    Camera?: any;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

type Controls = { steer: number; throttle: number; brake: number };

export default function NightDriveGame() {
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Loading camera…");
  const [started, setStarted] = useState(false);
  const [hudSpeed, setHudSpeed] = useState(0);
  const [hudScore, setHudScore] = useState(0);
  const [hudLives, setHudLives] = useState(3);
  const [gameOver, setGameOver] = useState(false);

  // shared control state, mutated by MediaPipe callback, read by game loop
  const controlsRef = useRef<Controls>({ steer: 0, throttle: 0, brake: 0 });
  const restartRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!started) return;
    const mount = mountRef.current!;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    // ---------- Renderer ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    // ---------- Scene & fog ----------
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9dd6ff);
    scene.fog = new THREE.Fog(0xbfe2ff, 120, 400);

    // Gradient sky (dome) — bright day
    const skyGeo = new THREE.SphereGeometry(500, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(0x3a86ff) },
        bottom: { value: new THREE.Color(0xdff3ff) },
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vPos; uniform vec3 top; uniform vec3 bottom; void main(){ float h = normalize(vPos).y * 0.5 + 0.5; gl_FragColor = vec4(mix(bottom, top, pow(h, 0.6)), 1.0); }`,
    });
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    // Sun
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(14, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0xfff2b8 }),
    );
    sun.position.set(120, 160, -260);
    scene.add(sun);

    // Clouds (simple flat sprites)
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    for (let i = 0; i < 14; i++) {
      const c = new THREE.Mesh(new THREE.SphereGeometry(8 + Math.random() * 10, 12, 8), cloudMat);
      c.position.set(-200 + Math.random() * 400, 90 + Math.random() * 40, -200 - Math.random() * 200);
      c.scale.y = 0.4;
      scene.add(c);
    }

    // ---------- Lights ----------
    scene.add(new THREE.HemisphereLight(0xbfe2ff, 0x89a06b, 0.9));
    const sunLight = new THREE.DirectionalLight(0xfff2d6, 1.4);
    sunLight.position.set(80, 180, 60);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -60;
    sunLight.shadow.camera.right = 60;
    sunLight.shadow.camera.top = 60;
    sunLight.shadow.camera.bottom = -60;
    sunLight.shadow.camera.far = 400;
    scene.add(sunLight);

    // ---------- Road ----------
    const ROAD_WIDTH = 14;
    const LANE_W = ROAD_WIDTH / 3;
    const SEG_LENGTH = 400;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, SEG_LENGTH * 2),
      new THREE.MeshStandardMaterial({ color: 0x4a8a3a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Road segments (two panels that leapfrog to fake infinite road)
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.9, metalness: 0.02 });
    const roads: THREE.Mesh[] = [];
    for (let i = 0; i < 2; i++) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_WIDTH, SEG_LENGTH), roadMat);
      road.rotation.x = -Math.PI / 2;
      road.position.y = 0.01;
      road.position.z = -i * SEG_LENGTH;
      road.receiveShadow = true;
      scene.add(road);
      roads.push(road);
    }

    // Lane markers (dashed) — reused via segments
    const dashGroup = new THREE.Group();
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xffe27a });
    for (let z = -SEG_LENGTH; z < SEG_LENGTH; z += 8) {
      for (const x of [-LANE_W / 2, LANE_W / 2]) {
        const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 4), dashMat);
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(x, 0.02, z);
        dashGroup.add(dash);
      }
    }
    // road edges
    for (const x of [-ROAD_WIDTH / 2, ROAD_WIDTH / 2]) {
      const edge = new THREE.Mesh(
        new THREE.PlaneGeometry(0.25, SEG_LENGTH * 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(x, 0.02, 0);
      dashGroup.add(edge);
    }
    scene.add(dashGroup);

    // ---------- City buildings & street lamps (endless via recycled arrays) ----------
    const cityGroup = new THREE.Group();
    scene.add(cityGroup);
    const buildingColors = [0x1b2340, 0x2a1b40, 0x40213a, 0x152238, 0x2c2c48];
    const dayBuildingColors = [0xd9d2c3, 0xbfa78a, 0xe6e0d3, 0xa89b8a, 0xc8b8a0, 0xead7b7];
    const buildings: THREE.Mesh[] = [];
    function makeBuilding(side: 1 | -1, z: number) {
      const w = 6 + Math.random() * 6;
      const h = 12 + Math.random() * 40;
      const d = 6 + Math.random() * 6;
      const geom = new THREE.BoxGeometry(w, h, d);
      const mat = new THREE.MeshStandardMaterial({
        color: dayBuildingColors[Math.floor(Math.random() * dayBuildingColors.length)],
        roughness: 0.85,
        metalness: 0.05,
      });
      void buildingColors;
      const b = new THREE.Mesh(geom, mat);
      b.castShadow = true;
      b.receiveShadow = true;
      const offset = ROAD_WIDTH / 2 + 8 + Math.random() * 20;
      b.position.set(side * offset, h / 2, z);
      cityGroup.add(b);
      buildings.push(b);
    }
    for (let z = 40; z > -600; z -= 10 + Math.random() * 8) {
      makeBuilding(1, z);
      makeBuilding(-1, z);
    }

    // Street lamps (with point lights, but only a subset lit to save perf)
    const lamps: { group: THREE.Group; light: THREE.PointLight }[] = [];
    for (let z = 20; z > -600; z -= 30) {
      for (const side of [-1, 1] as const) {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.08, 0.1, 6),
          new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.4 }),
        );
        pole.position.y = 3;
        g.add(pole);
        const head = new THREE.Mesh(
          new THREE.SphereGeometry(0.35, 12, 12),
          new THREE.MeshBasicMaterial({ color: 0xfff2b0 }),
        );
        head.position.set(side * -0.8, 6, 0);
        g.add(head);
        const light = new THREE.PointLight(0xffd48a, 0, 22, 2); // off in daytime
        light.position.copy(head.position);
        g.add(light);
        g.position.set(side * (ROAD_WIDTH / 2 + 1.2), 0, z);
        cityGroup.add(g);
        lamps.push({ group: g, light });
      }
    }

    // Palm trees for that VC vibe
    function makePalm(x: number, z: number) {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.22, 5),
        new THREE.MeshStandardMaterial({ color: 0x3a2a18, roughness: 1 }),
      );
      trunk.position.y = 2.5;
      g.add(trunk);
      for (let i = 0; i < 6; i++) {
        const leaf = new THREE.Mesh(
          new THREE.ConeGeometry(0.4, 2.2, 5),
          new THREE.MeshStandardMaterial({ color: 0x1f7a3a, roughness: 0.8 }),
        );
        leaf.position.set(0, 5, 0);
        leaf.rotation.z = Math.PI / 2.6;
        leaf.rotation.y = (i / 6) * Math.PI * 2;
        leaf.translateY(1);
        g.add(leaf);
      }
      g.position.set(x, 0, z);
      cityGroup.add(g);
      return g;
    }
    const palms: THREE.Group[] = [];
    for (let z = 0; z > -600; z -= 24) {
      palms.push(makePalm(-(ROAD_WIDTH / 2 + 3), z));
      palms.push(makePalm(ROAD_WIDTH / 2 + 3, z));
    }

    // ---------- Player car ----------
    function buildCar(bodyColor: number) {
      const car = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({
        color: bodyColor,
        metalness: 0.6,
        roughness: 0.35,
        envMapIntensity: 1.2,
      });
      const darkPlastic = new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.7, metalness: 0.2 });
      const chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.15, metalness: 1 });
      const glassMat = new THREE.MeshStandardMaterial({
        color: 0x2a3a4a,
        metalness: 0.4,
        roughness: 0.05,
        transparent: true,
        opacity: 0.55,
      });

      // Chassis (rounded main body via beveled box)
      const chassisGeo = new THREE.BoxGeometry(2.0, 0.45, 4.4, 2, 1, 2);
      const chassis = new THREE.Mesh(chassisGeo, bodyMat);
      chassis.position.y = 0.55;
      chassis.castShadow = true;
      car.add(chassis);

      // Hood (front, slightly lower)
      const hood = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.28, 1.4), bodyMat);
      hood.position.set(0, 0.85, 1.35);
      hood.castShadow = true;
      car.add(hood);

      // Trunk (rear)
      const trunk = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.32, 1.1), bodyMat);
      trunk.position.set(0, 0.87, -1.5);
      trunk.castShadow = true;
      car.add(trunk);

      // Cabin (roof)
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.55, 2.0), bodyMat);
      cabin.position.set(0, 1.15, -0.05);
      cabin.castShadow = true;
      car.add(cabin);
      // Roof top (slightly narrower for a rounded profile)
      const roof = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.1, 1.7), bodyMat);
      roof.position.set(0, 1.45, -0.05);
      roof.castShadow = true;
      car.add(roof);

      // Windshield / rear window / side windows (all glass)
      const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 0.15), glassMat);
      windshield.position.set(0, 1.2, 0.95);
      windshield.rotation.x = -0.35;
      car.add(windshield);
      const rearWindow = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 0.15), glassMat);
      rearWindow.position.set(0, 1.2, -1.05);
      rearWindow.rotation.x = 0.35;
      car.add(rearWindow);
      const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 1.85), glassMat);
      sideL.position.set(-0.9, 1.2, -0.05);
      car.add(sideL);
      const sideR = sideL.clone();
      sideR.position.x = 0.9;
      car.add(sideR);

      // Side mirrors
      const mirrorGeo = new THREE.BoxGeometry(0.28, 0.16, 0.18);
      const mirrorL = new THREE.Mesh(mirrorGeo, bodyMat);
      mirrorL.position.set(-1.05, 1.0, 0.7);
      const mirrorR = mirrorL.clone();
      mirrorR.position.x = 1.05;
      car.add(mirrorL, mirrorR);

      // Grille (front)
      const grille = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.2, 0.05), darkPlastic);
      grille.position.set(0, 0.55, 2.22);
      car.add(grille);
      // Front bumper
      const fBumper = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.25, 0.2), darkPlastic);
      fBumper.position.set(0, 0.4, 2.15);
      car.add(fBumper);
      // Rear bumper
      const rBumper = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.25, 0.2), darkPlastic);
      rBumper.position.set(0, 0.4, -2.15);
      car.add(rBumper);

      // Wheels with rims
      const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 24);
      const tireMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95 });
      const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.34, 16);
      const wheels: THREE.Mesh[] = [];
      const wPos: [number, number, number][] = [
        [-1.05, 0.42, 1.5],
        [1.05, 0.42, 1.5],
        [-1.05, 0.42, -1.5],
        [1.05, 0.42, -1.5],
      ];
      for (const [x, y, z] of wPos) {
        const w = new THREE.Mesh(wheelGeo, tireMat);
        w.rotation.z = Math.PI / 2;
        w.position.set(x, y, z);
        w.castShadow = true;
        const rim = new THREE.Mesh(rimGeo, chrome);
        rim.rotation.z = Math.PI / 2;
        // spokes
        for (let s = 0; s < 5; s++) {
          const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.36, 0.05), chrome);
          spoke.rotation.x = (s / 5) * Math.PI;
          rim.add(spoke);
        }
        w.add(rim);
        car.add(w);
        wheels.push(w);
      }
      // headlights
      const hlMat = new THREE.MeshStandardMaterial({
        color: 0xfffbe6,
        emissive: 0xfff2c0,
        emissiveIntensity: 0.6,
      });
      const hlGeo = new THREE.BoxGeometry(0.45, 0.18, 0.12);
      const hl1 = new THREE.Mesh(hlGeo, hlMat);
      hl1.position.set(-0.7, 0.65, 2.22);
      const hl2 = new THREE.Mesh(hlGeo, hlMat);
      hl2.position.set(0.7, 0.65, 2.22);
      car.add(hl1, hl2);
      // taillights
      const tlMat = new THREE.MeshStandardMaterial({
        color: 0xff2a3c,
        emissive: 0xff0011,
        emissiveIntensity: 0.5,
      });
      const tl1 = new THREE.Mesh(hlGeo, tlMat);
      tl1.position.set(-0.7, 0.7, -2.22);
      const tl2 = new THREE.Mesh(hlGeo, tlMat);
      tl2.position.set(0.7, 0.7, -2.22);
      car.add(tl1, tl2);
      return { car, wheels };
    }

    const { car: player, wheels: playerWheels } = buildCar(0xe63946);
    player.position.set(0, 0, 0);
    scene.add(player);

    // ---------- NPC traffic ----------
    const npcColors = [0x2f6fed, 0xf1c40f, 0x2ecc71, 0xe67e22, 0x9b59b6, 0xecf0f1];
    type NPC = { car: THREE.Group; wheels: THREE.Mesh[]; lane: number; speed: number };
    const npcs: NPC[] = [];
    function spawnNpc(zAhead: number) {
      const lane = Math.floor(Math.random() * 3) - 1; // -1, 0, 1
      const { car, wheels } = buildCar(npcColors[Math.floor(Math.random() * npcColors.length)]);
      car.position.set(lane * LANE_W, 0, zAhead);
      car.rotation.y = Math.PI; // facing us
      scene.add(car);
      npcs.push({ car, wheels, lane, speed: 8 + Math.random() * 10 });
    }
    for (let i = 0; i < 8; i++) spawnNpc(-60 - i * 40);

    // ---------- Camera ----------
    const camera = new THREE.PerspectiveCamera(70, width / height, 0.1, 800);
    camera.position.set(0, 4.2, 9);
    camera.lookAt(0, 1, -10);

    // ---------- Game state ----------
    let playerSpeed = 0; // world units / sec
    const maxSpeed = 55;
    let playerLane = 0; // -1..1 (continuous)
    let alive = true;
    let score = 0;
    let lives = 3;
    let invincibleT = 0;
    let travelled = 0;

    function reset() {
      playerSpeed = 0;
      playerLane = 0;
      alive = true;
      score = 0;
      lives = 3;
      invincibleT = 0;
      travelled = 0;
      player.position.set(0, 0, 0);
      player.rotation.y = 0;
      for (const n of npcs) scene.remove(n.car);
      npcs.length = 0;
      for (let i = 0; i < 8; i++) spawnNpc(-60 - i * 40);
      setGameOver(false);
      setHudLives(3);
      setHudScore(0);
    }
    restartRef.current = reset;

    // ---------- Loop ----------
    let last = performance.now();
    let raf = 0;
    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const c = controlsRef.current;
      if (alive) {
        // acceleration / braking
        if (c.throttle > 0.1) playerSpeed += c.throttle * 22 * dt;
        if (c.brake > 0.1) playerSpeed -= c.brake * 35 * dt;
        playerSpeed -= 4 * dt; // drag
        playerSpeed = Math.max(0, Math.min(maxSpeed, playerSpeed));

        // steering
        playerLane += c.steer * dt * 2.2;
        playerLane = Math.max(-1.4, Math.min(1.4, playerLane));
      } else {
        playerSpeed *= 0.94;
      }

      // move player laterally
      const targetX = playerLane * LANE_W;
      player.position.x += (targetX - player.position.x) * Math.min(1, dt * 6);
      player.rotation.y = -c.steer * 0.15;

      // Wheels spin
      const wheelSpin = playerSpeed * dt * 3;
      for (const w of playerWheels) w.rotation.x += wheelSpin;

      // World scrolls toward -Z past player; simulate by moving objects +Z at playerSpeed
      travelled += playerSpeed * dt;
      score += playerSpeed * dt * 0.5;

      // Scroll road panels
      for (const road of roads) {
        road.position.z += playerSpeed * dt;
        if (road.position.z > SEG_LENGTH) road.position.z -= SEG_LENGTH * 2;
      }
      // Scroll dashes/edges
      for (const child of dashGroup.children) {
        child.position.z += playerSpeed * dt;
        if (child.position.z > SEG_LENGTH) child.position.z -= SEG_LENGTH * 2;
      }
      // Scroll city
      for (const b of buildings) {
        b.position.z += playerSpeed * dt;
        if (b.position.z > 40) b.position.z -= 640;
      }
      for (const l of lamps) {
        l.group.position.z += playerSpeed * dt;
        if (l.group.position.z > 40) l.group.position.z -= 620;
      }
      for (const p of palms) {
        p.position.z += playerSpeed * dt;
        if (p.position.z > 20) p.position.z -= 620;
      }

      // NPCs (they move slower toward us; recycled when passed)
      for (const n of npcs) {
        n.car.position.z += (playerSpeed + n.speed) * dt;
        for (const w of n.wheels) w.rotation.x += (playerSpeed + n.speed) * dt * 3;
        if (n.car.position.z > 20) {
          n.lane = Math.floor(Math.random() * 3) - 1;
          n.car.position.set(n.lane * LANE_W, 0, -260 - Math.random() * 120);
          n.speed = 6 + Math.random() * 12;
        }
      }

      // Collision (simple AABB in local coords)
      if (alive) {
        if (invincibleT > 0) invincibleT -= dt;
        for (const n of npcs) {
          const dz = n.car.position.z - player.position.z;
          const dx = n.car.position.x - player.position.x;
          if (Math.abs(dz) < 4.2 && Math.abs(dx) < 1.9 && invincibleT <= 0) {
            lives -= 1;
            invincibleT = 1.5;
            playerSpeed *= 0.4;
            setHudLives(lives);
            if (lives <= 0) {
              alive = false;
              setGameOver(true);
            }
            // push npc back so we don't double-hit
            n.car.position.z = -80;
          }
        }
      }

      // flash player when invincible
      player.visible = invincibleT > 0 ? Math.floor(invincibleT * 12) % 2 === 0 : true;

      // Camera follow
      const camTargetX = player.position.x * 0.6;
      camera.position.x += (camTargetX - camera.position.x) * Math.min(1, dt * 3);
      camera.position.y = 4.2;
      camera.position.z = 9;
      camera.lookAt(player.position.x * 0.3, 1.2, player.position.z - 15);

      // HUD updates (throttled via React state on integer changes)
      const spd = Math.round(playerSpeed * 3.6 * 2); // pseudo km/h
      setHudSpeed(spd);
      setHudScore(Math.floor(score));

      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);

    // Resize
    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [started]);

  // ---------- MediaPipe hand tracking ----------
  useEffect(() => {
    if (!started) return;
    let hands: any = null;
    let camera: any = null;
    let cancelled = false;
    let rafFallback = 0;

    (async () => {
      try {
        await Promise.all([
          loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js"),
          loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js"),
        ]);
        if (cancelled) return;
        const video = videoRef.current!;
        // request camera
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240, facingMode: "user" },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();
        setStatus("Show your hand to steer");

        hands = new window.Hands({
          locateFile: (f: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 0,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.5,
        });
        hands.onResults((res: any) => {
          if (!res.multiHandLandmarks || res.multiHandLandmarks.length === 0) {
            controlsRef.current.throttle = 0;
            controlsRef.current.brake = 0;
            controlsRef.current.steer *= 0.9;
            return;
          }
          const lm = res.multiHandLandmarks[0];
          // Steering: horizontal position of wrist (0 = left, 1 = right on webcam)
          // But webcam is mirrored: use 0.5 - x to invert so tilting hand right steers right.
          const wrist = lm[0];
          const steer = (0.5 - wrist.x) * 2.5; // -1.25..1.25
          controlsRef.current.steer = Math.max(-1, Math.min(1, steer));

          // Open/closed detection: distance between tips and wrist vs. hand size
          const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);
          const palmSize = dist(lm[0], lm[9]);
          const fingersOpen =
            [8, 12, 16, 20].filter((i) => dist(lm[i], lm[0]) > palmSize * 1.6).length;
          if (fingersOpen >= 3) {
            controlsRef.current.throttle = 1;
            controlsRef.current.brake = 0;
          } else if (fingersOpen <= 1) {
            controlsRef.current.throttle = 0;
            controlsRef.current.brake = 1;
          } else {
            controlsRef.current.throttle = 0.3;
            controlsRef.current.brake = 0;
          }
        });

        camera = new window.Camera(video, {
          onFrame: async () => {
            if (hands) await hands.send({ image: video });
          },
          width: 320,
          height: 240,
        });
        camera.start();
      } catch (err) {
        console.error(err);
        setStatus("Camera blocked — using keyboard: ← → to steer, ↑ throttle, ↓ brake");
        // keyboard fallback
        const keys: Record<string, boolean> = {};
        const kd = (e: KeyboardEvent) => { keys[e.key] = true; };
        const ku = (e: KeyboardEvent) => { keys[e.key] = false; };
        window.addEventListener("keydown", kd);
        window.addEventListener("keyup", ku);
        const tick = () => {
          controlsRef.current.steer =
            (keys["ArrowRight"] ? 1 : 0) - (keys["ArrowLeft"] ? 1 : 0);
          controlsRef.current.throttle = keys["ArrowUp"] ? 1 : 0;
          controlsRef.current.brake = keys["ArrowDown"] ? 1 : 0;
          rafFallback = requestAnimationFrame(tick);
        };
        rafFallback = requestAnimationFrame(tick);
      }
    })();

    return () => {
      cancelled = true;
      if (camera) camera.stop?.();
      if (hands) hands.close?.();
      const v = videoRef.current;
      if (v && v.srcObject) {
        (v.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
        v.srcObject = null;
      }
      if (rafFallback) cancelAnimationFrame(rafFallback);
    };
  }, [started]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-white">
      <div ref={mountRef} className="absolute inset-0" />

      {/* Webcam preview */}
      <div className="absolute right-4 top-4 z-20 rounded-xl border border-white/20 bg-black/40 p-2 backdrop-blur">
        <video
          ref={videoRef}
          className="h-32 w-44 -scale-x-100 rounded-lg object-cover"
          playsInline
          muted
        />
        <div className="mt-1 text-center text-[10px] uppercase tracking-widest opacity-70">
          {status}
        </div>
      </div>

      {/* HUD */}
      {started && (
        <>
          <div className="pointer-events-none absolute left-4 top-4 z-20 space-y-2 font-mono">
            <div className="rounded-lg border border-cyan-400/40 bg-black/50 px-4 py-2 backdrop-blur">
              <div className="text-[10px] uppercase tracking-widest text-cyan-300/80">Score</div>
              <div className="text-2xl font-bold text-cyan-200">{String(hudScore).padStart(6, "0")}</div>
            </div>
            <div className="rounded-lg border border-pink-400/40 bg-black/50 px-4 py-2 backdrop-blur">
              <div className="text-[10px] uppercase tracking-widest text-pink-300/80">Lives</div>
              <div className="text-2xl">{"❤️".repeat(Math.max(0, hudLives))}</div>
            </div>
          </div>

          <div className="pointer-events-none absolute bottom-6 left-1/2 z-20 -translate-x-1/2 font-mono">
            <div className="flex items-end gap-2 rounded-2xl border border-white/20 bg-black/50 px-6 py-3 backdrop-blur">
              <div className="text-6xl font-black leading-none text-white">{hudSpeed}</div>
              <div className="pb-1 text-xs uppercase tracking-widest opacity-70">km/h</div>
            </div>
          </div>
        </>
      )}

      {/* Start overlay */}
      {!started && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-gradient-to-b from-black/80 to-black/60 backdrop-blur">
          <div className="max-w-lg rounded-2xl border border-white/20 bg-black/70 p-8 text-center shadow-2xl">
            <h1 className="mb-2 bg-gradient-to-r from-sky-400 via-emerald-300 to-yellow-300 bg-clip-text font-mono text-5xl font-black tracking-widest text-transparent">
              DAY DRIVE
            </h1>
            <p className="mb-6 text-sm opacity-80">
              3D daytime racing. Tilt your hand to steer, open palm to accelerate, fist to brake. Dodge traffic and cruise the sunny highway.
            </p>
            <ul className="mb-6 space-y-1 text-left text-sm opacity-80">
              <li>✋ Open hand → accelerate</li>
              <li>✊ Fist → brake</li>
              <li>👉 Move hand left/right → steer</li>
              <li>⌨️ No camera? Arrow keys still work.</li>
            </ul>
            <button
              onClick={() => setStarted(true)}
              className="rounded-full bg-gradient-to-r from-pink-500 to-cyan-400 px-8 py-3 font-bold uppercase tracking-widest text-black shadow-lg transition hover:scale-105"
            >
              Start Engine
            </button>
          </div>
        </div>
      )}

      {/* Game over */}
      {gameOver && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 backdrop-blur">
          <div className="rounded-2xl border border-red-400/40 bg-black/80 p-8 text-center">
            <h2 className="mb-2 font-mono text-4xl font-black text-red-400">CRASHED</h2>
            <p className="mb-6 opacity-80">Final score: {hudScore}</p>
            <button
              onClick={() => restartRef.current()}
              className="rounded-full bg-white px-6 py-2 font-bold uppercase tracking-widest text-black hover:scale-105"
            >
              Restart
            </button>
          </div>
        </div>
      )}
    </div>
  );
}