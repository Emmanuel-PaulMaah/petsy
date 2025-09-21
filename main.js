import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { XRButton } from 'https://unpkg.com/three@0.160.0/examples/jsm/webxr/XRButton.js';

let renderer, scene, camera, clock;
let xrRefSpace, xrViewerSpace, hitTestSource = null;

let reticle;
let petRoot;                 // anchor on the plane
let pet;                     // the actual character (group)
let placed = false;
let paused = false;

const $status = document.getElementById('status');
const $btnReset = document.getElementById('reset');
const $btnPause = document.getElementById('pause');
const $btnJump  = document.getElementById('btnJump');
const $btnSpin  = document.getElementById('btnSpin');
const $btnDance = document.getElementById('btnDance');

// simple animation queue
const queue = [];
let currentAnim = null;

init();

function init() {
  // renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  // scene + camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 30);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333366, 1.0));
  scene.fog = new THREE.FogExp2(0x000000, 0.12);

  // reticle
  reticle = makeReticle();
  reticle.visible = false;
  scene.add(reticle);

  // root + pet
  petRoot = new THREE.Group();
  scene.add(petRoot);

  pet = buildPrimitivePet();
  pet.visible = false;
  scene.add(pet);

  // input
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', onResize);
  $btnReset.addEventListener('click', resetGame);
  $btnPause.addEventListener('click', () => { paused = !paused; $btnPause.textContent = paused ? 'resume' : 'pause'; });
  $btnJump.addEventListener('click', () => enqueue('jump'));
  $btnSpin.addEventListener('click', () => enqueue('spin'));
  $btnDance.addEventListener('click', () => enqueue('dance'));

  // XR entry
  document.body.appendChild(XRButton.createButton(renderer, {
    requiredFeatures: ['hit-test', 'local-floor'],
    optionalFeatures: []
  }));

  renderer.xr.addEventListener('sessionstart', async () => {
    const session = renderer.xr.getSession();
    xrRefSpace = await session.requestReferenceSpace('local-floor');
    xrViewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({ space: xrViewerSpace });
    clock = new THREE.Clock();
  });

  renderer.xr.addEventListener('sessionend', () => {
    hitTestSource = null;
    placed = false;
    currentAnim = null;
    queue.length = 0;
    pet.visible = false;
    $status.textContent = 'find a surface, then tap to place your pet.';
    setButtons(false);
  });

  renderer.setAnimationLoop(onXRFrame);

  window.__app = { THREE, scene, renderer, camera, pet };
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onXRFrame(time, frame) {
  const dt = clock ? clock.getDelta() : 0.016;

  updateReticle(frame);

  if (!paused) {
    updateAnimation(time, dt);
  }

  renderer.render(scene, camera);
}

// ---- reticle / placement ---------------------------------------------------

function updateReticle(frame) {
  if (!hitTestSource || !frame || placed) { reticle.visible = false; return; }
  const hits = frame.getHitTestResults(hitTestSource);
  if (hits.length) {
    const pose = hits[0].getPose(xrRefSpace);
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale);
      $status.textContent = 'tap to place your pet.';
    } else {
      reticle.visible = false;
    }
  } else {
    reticle.visible = false;
    if (!placed) $status.textContent = 'move phone to help it find a surface…';
  }
}

function onPointerDown(e) {
  if (!placed) {
    placePetAtReticleOrFallback();
    return;
  }

  // raycast to see if pet was tapped → cycle to next animation
  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), renderer.xr.getCamera(camera));
  const hit = raycaster.intersectObject(pet, true)[0];
  if (hit) cycle();
}

function placePetAtReticleOrFallback() {
  if (reticle.visible) {
    petRoot.position.copy(reticle.position);
    petRoot.quaternion.copy(reticle.quaternion);
  } else {
    // fallback: 1.2m forward
    const xrCam = renderer.xr.getCamera(camera);
    const origin = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
    const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(xrCam.quaternion).normalize();
    petRoot.position.copy(origin).addScaledVector(fwd, 1.2);
    petRoot.position.y -= 0.8;
    petRoot.lookAt(origin);
  }
  // set pet transform
  pet.position.copy(petRoot.position);
  pet.quaternion.copy(petRoot.quaternion);
  pet.visible = true;
  placed = true;
  $status.textContent = 'tap the pet or use buttons to animate.';
  setButtons(true);

  // idle wobble baseline
  enqueue('idle');
}

// ---- pet build (primitives) -----------------------------------------------

function buildPrimitivePet() {
  const g = new THREE.Group();
  g.name = 'pet';

  // body (squishy capsule made of sphere + cylinder)
  const body = new THREE.Group();
  const belly = new THREE.SphereGeometry(0.12, 16, 12);
  const bellyMesh = new THREE.Mesh(belly, new THREE.MeshStandardMaterial({ color: 0x8fb3ff, roughness: 0.5 }));
  const torso = new THREE.CylinderGeometry(0.12, 0.12, 0.16, 16);
  const torsoMesh = new THREE.Mesh(torso, new THREE.MeshStandardMaterial({ color: 0x8fb3ff, roughness: 0.5 }));
  torsoMesh.position.y = 0.12;
  bellyMesh.position.y = 0.04;
  body.add(bellyMesh, torsoMesh);
  body.position.y = 0.12;

  // eyes
  const eyeGeo = new THREE.SphereGeometry(0.018, 12, 10);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.04, 0.22, 0.10);
  const eyeR = eyeL.clone(); eyeR.position.x *= -1;

  // ears (little cones)
  const earGeo = new THREE.ConeGeometry(0.04, 0.06, 10);
  const earMat = new THREE.MeshStandardMaterial({ color: 0x6e92e6, roughness: 0.6 });
  const earL = new THREE.Mesh(earGeo, earMat); earL.position.set(-0.06, 0.32, 0.0); earL.rotation.z = 0.3;
  const earR = earL.clone(); earR.position.x *= -1; earR.rotation.z = -0.3;

  // feet
  const footGeo = new THREE.CapsuleGeometry(0.03, 0.02, 6, 8);
  const footMat = new THREE.MeshStandardMaterial({ color: 0x6e92e6 });
  const footL = new THREE.Mesh(footGeo, footMat); footL.position.set(-0.06, 0.02, 0.02);
  const footR = footL.clone(); footR.position.x *= -1;

  g.add(body, eyeL, eyeR, earL, earR, footL, footR);
  g.userData.body = body;
  g.userData.ears = [earL, earR];
  g.userData.eyes = [eyeL, eyeR];

  return g;
}

// ---- animation system (tiny) ----------------------------------------------

function enqueue(kind) {
  // put a named animation into the queue
  queue.push(kind);
  // if nothing playing, start immediately
  if (!currentAnim) startNextAnim();
}

function cycle() {
  // rotate through jump → spin → dance
  const order = ['jump','spin','dance'];
  const next = order[((order.indexOf(currentAnim?.kind) + 1) || 0) % order.length] || 'jump';
  enqueue(next);
}

function startNextAnim() {
  const next = queue.shift();
  if (!next) return;
  // cancel any leftover state
  currentAnim = { kind: next, t0: performance.now() };

  // set per-anim params
  if (next === 'idle') {
    currentAnim.dur = Infinity;
  } else if (next === 'jump') {
    currentAnim.dur = 600;
  } else if (next === 'spin') {
    currentAnim.dur = 900;
  } else if (next === 'dance') {
    currentAnim.dur = 1400;
  }
}

function updateAnimation(now, dt) {
  if (!pet.visible) return;

  // idle wobble always-on baseline
  const wobble = Math.sin(now * 0.003) * 0.01;
  pet.position.y = petRoot.position.y + wobble;

  // subtle ear flop
  if (pet.userData?.ears) {
    const e = pet.userData.ears;
    e[0].rotation.z = 0.3 + Math.sin(now * 0.004) * 0.12;
    e[1].rotation.z = -0.3 - Math.cos(now * 0.004) * 0.12;
  }

  if (!currentAnim) return;

  const t = (performance.now() - currentAnim.t0);
  const k = currentAnim.kind;

  if (k === 'jump') {
    // ease up then down
    const p = Math.min(1, t / 600);
    const y = easeOut(p) * 0.22 - (p > 0.5 ? (p - 0.5) * 0.44 : 0); // up then down
    pet.position.y = petRoot.position.y + wobble + y;
    pet.scale.setScalar(1 + 0.08 * Math.sin(p * Math.PI)); // squash & stretch
  }

  if (k === 'spin') {
    const p = Math.min(1, t / 900);
    pet.rotation.y = easeInOut(p) * Math.PI * 2;
  }

  if (k === 'dance') {
    const p = Math.min(1, t / 1400);
    // side step + arm flail (ears)
    pet.position.x = petRoot.position.x + Math.sin(p * Math.PI * 4) * 0.12;
    if (pet.userData?.ears) {
      const e = pet.userData.ears;
      e[0].rotation.x = Math.sin(p * Math.PI * 8) * 0.6;
      e[1].rotation.x = -Math.sin(p * Math.PI * 8) * 0.6;
    }
  }

  if (t >= currentAnim.dur) {
    // reset transforms that might drift
    pet.scale.setScalar(1);
    pet.rotation.y = 0;
    pet.position.x = petRoot.position.x;
    // chain next or fall back to idle
    currentAnim = null;
    startNextAnim();
    if (!currentAnim) enqueue('idle');
  }
}

function setButtons(enabled) {
  [$btnJump, $btnSpin, $btnDance].forEach(b => b.disabled = !enabled);
}

// ---- utils / visuals -------------------------------------------------------

function resetGame() {
  placed = false;
  paused = false; $btnPause.textContent = 'pause';
  $status.textContent = 'find a surface, then tap to place your pet.';
  setButtons(false);
  pet.visible = false;
  queue.length = 0;
  currentAnim = null;
}

function easeOut(t){ return 1 - Math.pow(1 - t, 3); }
function easeInOut(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }

function makeReticle() {
  const g1 = new THREE.RingGeometry(0.06, 0.075, 48);
  const m1 = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const ring = new THREE.Mesh(g1, m1);
  ring.rotation.x = -Math.PI / 2;

  const g2 = new THREE.CircleGeometry(0.006, 16);
  const m2 = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const dot = new THREE.Mesh(g2, m2);
  dot.position.y = 0.001; dot.rotation.x = -Math.PI / 2;

  const group = new THREE.Group();
  group.add(ring, dot);
  return group;
}
