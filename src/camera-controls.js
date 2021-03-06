const Keyboard = require('game-keyboard');
const keyMap = require('game-keyboard/key_map').US;

let THREE;
const EPSILON = 0.001;
const STATE = {
  NONE: -1,
  ROTATE: 0,
  DOLLY: 1,
  PAN: 2,
  TOUCH_ROTATE: 3,
  TOUCH_DOLLY: 4,
  TOUCH_PAN: 5,
  ROTATE_FP: 6, // rotate first person mode
  FP_NAVIGATE: 7, // first person navigate mode (WASD)
};
const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') !== -1;

function matchSphericals(base, target) {
  const diff = Math.PI * 2;
  const halfDiff = diff * 0.5;
  while (Math.abs(base.theta - target.theta) > halfDiff) {
    base.theta += base.theta < target.theta ? diff : -diff;
  }
}

export class CameraControls {
  static install(THREE_) {
    THREE = THREE_;
  }

  constructor(object, domElement) {
    this.object = object;
    this.domElement = domElement;

    this.enabled = true;
    this.minDistance = 0;
    this.maxDistance = Infinity;
    this.minPolarAngle = 0; // radians
    this.maxPolarAngle = Math.PI; // radians
    this.minAzimuthAngle = -Infinity; // radians
    this.maxAzimuthAngle = Infinity; // radians
    this.dampingFactor = 0.5;
    this.draggingDampingFactor = 0.1;
    this.minZoomDistance = 0.3;
    this.maxZoomDistance = 1;
    this.panSpeed = 1.0;
    this.minPanDistance = 1.0;
    this.rotationSpeed = 0.005;
    this.enableKeyboardNavigation = true;
    this.minDistToTarget = 2;

    // the location of focus, where the object orbits around
    this.target = new THREE.Vector3();
    this.targetEnd = new THREE.Vector3();

    // rotation
    this.spherical = new THREE.Spherical();
    this.spherical.setFromVector3(this.object.position);
    this.sphericalEnd = new THREE.Spherical().copy(this.spherical);

    // state
    this.state = STATE.NONE;
    this.keyboard = new Keyboard(keyMap);

    // reset
    this.target0 = this.target.clone();
    this.position0 = this.object.position.clone();

    this.wasdKeys = ['w', 'a', 's', 'd'];

    // cached variables
    this.mouse = new THREE.Vector2();
    this.plane = new THREE.Plane();
    this.line3 = new THREE.Line3();
    this.v3 = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.xColumn = new THREE.Vector3();
    this.yColumn = new THREE.Vector3();
    this.dragStart = new THREE.Vector2();
    this.dollyStart = new THREE.Vector2();

    // use this
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onTouchStart = this.onTouchStart.bind(this);
    this.onMouseWheel = this.onMouseWheel.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);
    this.dragging = this.dragging.bind(this);
    this.startDragging = this.startDragging.bind(this);
    this.endDragging = this.endDragging.bind(this);

    this.needsUpdate = true;
    this.update();

    if (!this.domElement) {
      this.dispose = () => {};
    } else {
      this.domElement.addEventListener('mousedown', this.onMouseDown);
      this.domElement.addEventListener('touchstart', this.onTouchStart);
      this.domElement.addEventListener('wheel', this.onMouseWheel);
      this.domElement.addEventListener('DOMMouseScroll', this.onMouseWheel);
      this.domElement.addEventListener('contextmenu', this.onContextMenu);

      this.dispose = () => {
        this.domElement.removeEventListener('mousedown', this.onMouseDown);
        this.domElement.removeEventListener('touchstart', this.onTouchStart);
        this.domElement.removeEventListener('wheel', this.onMouseWheel);
        this.domElement.removeEventListener(
          'DOMMouseScroll',
          this.onMouseWheel
        );
        this.domElement.removeEventListener('contextmenu', this.onContextMenu);
        document.removeEventListener('mousemove', this.dragging);
        document.removeEventListener('touchmove', this.dragging);
        document.removeEventListener('mouseup', this.endDragging);
        document.removeEventListener('touchend', this.endDragging);
      };
    }
  }

  onMouseDown(event) {
    if (!this.enabled) return;

    event.preventDefault();

    const prevState = this.state;

    this.elementRect = this.domElement.getBoundingClientRect();
    switch (event.button) {
      case THREE.MOUSE.LEFT: {
        const shift = this.keyboard.isPressed('shift');
        this.state = shift ? STATE.ROTATE_FP : STATE.ROTATE;
        if (this.state === STATE.ROTATE) {
          const isWasdDown =
            this.wasdKeys.filter(key => this.keyboard.isPressed(key)).length >
            0;
          if (isWasdDown) {
            this.state = STATE.ROTATE_FP;
          }
        }
        break;
      }

      case THREE.MOUSE.MIDDLE:
        this.state = STATE.DOLLY;
        break;

      case THREE.MOUSE.RIGHT:
        this.state = STATE.PAN;
        break;

      default:
        break;
    }

    if (prevState === STATE.NONE) {
      this.startDragging(event);
    }
  }

  onTouchStart(event) {
    if (!this.enabled) return;

    event.preventDefault();

    this.elementRect = this.domElement.getBoundingClientRect();

    const prevState = this.state;

    switch (event.touches.length) {
      case 1: // one-fingered touch: rotate
        this.state = STATE.TOUCH_ROTATE;
        break;

      case 2: // two-fingered touch: dolly
        this.state = STATE.TOUCH_DOLLY;
        break;

      case 3: // three-fingered touch: pan
        this.state = STATE.TOUCH_PAN;
        break;

      default:
        break;
    }

    if (prevState === STATE.NONE) {
      this.startDragging(event);
    }
  }

  onMouseWheel(event) {
    if (!this.enabled) return;

    event.preventDefault();

    const x = (event.offsetX / this.domElement.clientWidth) * 2 - 1;
    const y = -(event.offsetY / this.domElement.clientHeight) * 2 + 1;

    let delta = 0;
    if (event.wheelDelta) {
      // WebKit / Opera / Explorer 9
      delta = -event.wheelDelta / 40;
    } else if (event.detail) {
      // Firefox
      delta = event.detail;
    } else if (event.deltaY) {
      // Firefox / Explorer + event target is SVG.
      const factor = isFirefox ? 1 : 40;
      delta = event.deltaY / factor;
    }

    if (delta < 0) {
      this.dollyIn(x, y, 1);
    } else {
      this.dollyOut(x, y, 1);
    }
  }

  checkKeyboardEvents() {
    if (!this.enabled || !this.enableKeyboardNavigation) return;
    const { keyboard } = this;
    const shift = keyboard.isPressed('shift');

    const fastMoving = shift;
    const distanceUnit = fastMoving ? 1 : 0.2;

    const keyboardPan = (deltaX, deltaY) => {
      const distance = this.getZoomDistance(true, distanceUnit);
      this.pan(deltaX * distance, deltaY * distance, true);
    };

    let change = false;
    if (keyboard.isPressed('w')) {
      change = true;
      this.dollyIn(0, 0, distanceUnit);
    }
    if (keyboard.isPressed('s')) {
      change = true;
      this.dollyOut(0, 0, distanceUnit);
    }
    if (keyboard.isPressed('a')) {
      change = true;
      keyboardPan(1, 0);
    }
    if (keyboard.isPressed('d')) {
      change = true;
      keyboardPan(-1, 0);
    }

    const rotationSpeed = fastMoving ? 10 : 5;
    if (keyboard.isPressed('left')) {
      change = true;
      this.rotatetFP(rotationSpeed, 0);
    }
    if (keyboard.isPressed('up')) {
      change = true;
      this.rotatetFP(0, rotationSpeed * 0.5);
    }
    if (keyboard.isPressed('down')) {
      change = true;
      this.rotatetFP(0, -rotationSpeed * 0.5);
    }
    if (keyboard.isPressed('right')) {
      change = true;
      this.rotatetFP(-rotationSpeed, 0);
    }

    if (change) {
      this.needsUpdate = true;
    }
  }

  onContextMenu(event) {
    if (!this.enabled) return;
    event.preventDefault();
  }

  startDragging(e) {
    if (!this.enabled) return;

    e.preventDefault();

    const event = e.touches ? e.touches[0] : e;
    const x = event.clientX;
    const y = event.clientY;

    this.dragStart.set(x, y);

    if (this.state === STATE.TOUCH_DOLLY) {
      const dx = x - e.touches[1].pageX;
      const dy = y - e.touches[1].pageY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      this.dollyStart.set(0, distance);
    }

    this.dampingFactor = this.draggingDampingFactor;

    document.addEventListener('mousemove', this.dragging, {
      passive: false,
    });
    document.addEventListener('touchmove', this.dragging, {
      passive: false,
    });
    document.addEventListener('mouseup', this.endDragging);
    document.addEventListener('touchend', this.endDragging);
  }

  dragging(e) {
    if (!this.enabled) return;

    e.preventDefault();

    const event = e.touches ? e.touches[0] : e;
    const x = event.clientX;
    const y = event.clientY;

    const deltaX = this.dragStart.x - x;
    const deltaY = this.dragStart.y - y;

    this.dragStart.set(x, y);

    switch (this.state) {
      case STATE.ROTATE:
      case STATE.TOUCH_ROTATE: {
        const rotX = (2 * Math.PI * deltaX) / this.elementRect.width;
        const rotY = (2 * Math.PI * deltaY) / this.elementRect.height;
        this.rotate(rotX, rotY, true);
        break;
      }

      case STATE.DOLLY:
        // not implemented
        break;

      case STATE.TOUCH_DOLLY: {
        const dx = x - e.touches[1].pageX;
        const dy = y - e.touches[1].pageY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const dollyDelta = this.dollyStart.y - distance;

        const centerX = (x + e.touches[1].pageX) / 2;
        const centerY = (y + e.touches[1].pageY) / 2;
        const glX = (centerX / this.domElement.clientWidth) * 2 - 1;
        const glY = -(centerY / this.domElement.clientHeight) * 2 + 1;

        if (dollyDelta > 0) {
          this.dollyOut(glX, glY);
        } else if (dollyDelta < 0) {
          this.dollyIn(glX, glY);
        }

        this.dollyStart.set(0, distance);
        break;
      }

      case STATE.PAN:
      case STATE.TOUCH_PAN: {
        const offset = this.v3.copy(this.object.position).sub(this.target);
        // half of the fov is center to top of screen
        const targetDistance =
          offset.length() * Math.tan(((this.object.fov / 2) * Math.PI) / 180);

        let panX =
          (this.panSpeed * deltaX * targetDistance) / this.elementRect.height;
        let panY =
          (this.panSpeed * deltaY * targetDistance) / this.elementRect.height;
        panX = THREE.Math.clamp(
          panX,
          -this.minPanDistance,
          this.minPanDistance
        );
        panY = THREE.Math.clamp(
          panY,
          -this.minPanDistance,
          this.minPanDistance
        );
        this.pan(panX, panY, true);
        break;
      }

      case STATE.ROTATE_FP: {
        this.rotatetFP(deltaX, deltaY);
        break;
      }

      default:
        break;
    }
  }

  endDragging() {
    if (!this.enabled) return;

    this.dampingFactor = this.dampingFactor;
    this.state = STATE.NONE;

    document.removeEventListener('mousemove', this.dragging);
    document.removeEventListener('touchmove', this.dragging);
    document.removeEventListener('mouseup', this.endDragging);
    document.removeEventListener('touchend', this.endDragging);
  }

  // x, y is coordinate to zoom to. It is in GL coordinates (-1, +1)
  dollyIn(x = 0, y = 0, distanceUnits = 1) {
    this.dolly(this.getZoomDistance(true, distanceUnits), true, x, y);
  }

  dollyOut(x = 0, y = 0, distanceUnits = 1) {
    this.dolly(this.getZoomDistance(false, distanceUnits), true, x, y);
  }

  // rotX in radian
  // rotY in radian
  rotate(rotX, rotY, enableTransition) {
    this.rotateTo(
      this.sphericalEnd.theta + rotX,
      this.sphericalEnd.phi + rotY,
      enableTransition
    );
  }

  // rotX in radian
  // rotY in radian
  rotateTo(rotX, rotY, enableTransition) {
    const theta = Math.max(
      this.minAzimuthAngle,
      Math.min(this.maxAzimuthAngle, rotX)
    );
    const phi = Math.max(
      this.minPolarAngle,
      Math.min(this.maxPolarAngle, rotY)
    );

    this.sphericalEnd.theta = theta;
    this.sphericalEnd.phi = phi;
    this.sphericalEnd.radius = this.spherical.radius;
    this.sphericalEnd.makeSafe();

    this.targetEnd.copy(this.target);

    if (!enableTransition) {
      this.spherical.theta = this.sphericalEnd.theta;
      this.spherical.phi = this.sphericalEnd.phi;
    }

    this.needsUpdate = true;
  }

  rotatetFP(deltaX, deltaY) {
    const camera = this.object.clone();
    camera.position.setFromSpherical(this.sphericalEnd).add(this.targetEnd);
    camera.lookAt(this.targetEnd);

    camera.rotateY(deltaX * this.rotationSpeed);
    camera.rotateX(deltaY * this.rotationSpeed);

    const cameraDirection = camera.getWorldDirection();
    this.v3.subVectors(this.targetEnd, camera.position);
    const distToTarget = this.targetEnd.distanceTo(camera.position);
    this.targetEnd.addVectors(
      camera.position,
      cameraDirection.multiplyScalar(distToTarget)
    );

    this.sphericalEnd.setFromVector3(
      this.v3.subVectors(camera.position, this.targetEnd)
    );
    matchSphericals(this.sphericalEnd, this.spherical);

    this.needsUpdate = true;
  }

  getZoomDistance(zoomIn, distanceUnits) {
    const { radius } = this.sphericalEnd;
    let distance;
    const near = this.minDistToTarget;
    const far = near * 100;

    if (radius <= this.minDistToTarget) {
      distance = this.minZoomDistance;
    } else if (radius >= far) {
      distance = this.maxZoomDistance;
    } else {
      const a = (this.maxZoomDistance - this.minZoomDistance) / (far - near);
      distance = this.minZoomDistance + a * (radius - near);
    }

    if (zoomIn) {
      distance = -distance;
    }

    distance *= distanceUnits;
    return distance;
  }

  dolly(distance, enableTransition, x, y) {
    this.dollyTo(this.sphericalEnd.radius + distance, enableTransition, x, y);
  }

  dollyTo(distance, enableTransition, x, y) {
    const newDistanceToTarget = THREE.Math.clamp(
      distance,
      this.minDistance,
      this.maxDistance
    );
    const { radius } = this.sphericalEnd;
    const cameraMoveDistance = radius - newDistanceToTarget;

    this.mouse.set(x, y);
    // using camera's final position
    const camera = this.object.clone();
    camera.position.setFromSpherical(this.sphericalEnd).add(this.targetEnd);
    camera.lookAt(this.targetEnd);
    this.raycaster.setFromCamera(this.mouse, camera);

    const cameraNormal = camera.getWorldDirection();
    const targetPointPlane = this.plane;
    targetPointPlane.setFromNormalAndCoplanarPoint(
      cameraNormal,
      this.targetEnd
    );

    const cameraOffset = this.raycaster.ray.direction
      .clone()
      .multiplyScalar(cameraMoveDistance);
    camera.position.add(cameraOffset);

    const projectLine = this.line3;
    const lineLength = -targetPointPlane.distanceToPoint(camera.position);
    projectLine.set(
      camera.position,
      camera.position
        .clone()
        .add(cameraNormal.clone().multiplyScalar(lineLength * 2))
    );
    const intersect = targetPointPlane.intersectLine(projectLine);
    this.targetEnd.copy(intersect);

    this.sphericalEnd.radius = this.targetEnd.distanceTo(camera.position);
    const diff = this.minDistToTarget - this.sphericalEnd.radius;
    if (diff > 0) {
      const cameraDirection = camera.getWorldDirection();
      this.targetEnd.add(cameraDirection.multiplyScalar(diff));
      this.sphericalEnd.radius = this.minDistToTarget;
    }

    if (!enableTransition) {
      this.spherical.radius = this.sphericalEnd.radius;
      this.update();
    }

    this.needsUpdate = true;
  }

  pan(x, y, enableTransition) {
    // use the camera position at targetEnd, sphericalEnd as the base
    const camera = this.object.clone();
    camera.position.setFromSpherical(this.sphericalEnd).add(this.targetEnd);
    camera.lookAt(this.targetEnd);

    camera.updateMatrix();

    this.xColumn.setFromMatrixColumn(camera.matrix, 0);
    this.yColumn.setFromMatrixColumn(camera.matrix, 1);
    this.xColumn.multiplyScalar(x);
    this.yColumn.multiplyScalar(-y);

    const offset = this.v3.copy(this.xColumn).add(this.yColumn);
    this.targetEnd.add(offset);

    if (!enableTransition) {
      this.target.copy(this.targetEnd);
    }

    this.needsUpdate = true;
  }

  moveTo(x, y, z, enableTransition) {
    this.targetEnd.set(x, y, z);

    if (!enableTransition) {
      this.target.copy(this.targetEnd);
    }

    this.needsUpdate = true;
  }

  getState() {
    return this.state;
  }

  reset(enableTransition) {
    this.targetEnd.copy(this.target0);
    this.sphericalEnd.setFromVector3(this.position0);
    this.sphericalEnd.theta = this.sphericalEnd.theta % (2 * Math.PI);
    this.spherical.theta = this.spherical.theta % (2 * Math.PI);

    if (!enableTransition) {
      this.target.copy(this.targetEnd);
      this.spherical.copy(this.sphericalEnd);
    }

    this.needsUpdate = true;
  }

  setCameraPosition(position, target) {
    this.target0.copy(target);
    this.position0.copy(position.clone().sub(target));
    this.reset();
  }

  update(delta) {
    let dampingFactor = 1;
    if (delta != null) {
      dampingFactor = (this.dampingFactor * delta) / 0.016;
    }
    const deltaTheta = this.sphericalEnd.theta - this.spherical.theta;
    const deltaPhi = this.sphericalEnd.phi - this.spherical.phi;
    const deltaRadius = this.sphericalEnd.radius - this.spherical.radius;
    const deltaTarget = new THREE.Vector3().subVectors(
      this.targetEnd,
      this.target
    );

    if (
      Math.abs(deltaTheta) > EPSILON ||
      Math.abs(deltaPhi) > EPSILON ||
      Math.abs(deltaRadius) > EPSILON ||
      Math.abs(deltaTarget.x) > EPSILON ||
      Math.abs(deltaTarget.y) > EPSILON ||
      Math.abs(deltaTarget.z) > EPSILON
    ) {
      this.spherical.set(
        this.spherical.radius + deltaRadius * dampingFactor,
        this.spherical.phi + deltaPhi * dampingFactor,
        this.spherical.theta + deltaTheta * dampingFactor
      );

      this.target.add(deltaTarget.multiplyScalar(dampingFactor));

      this.needsUpdate = true;
    } else {
      this.spherical.copy(this.sphericalEnd);
      this.target.copy(this.targetEnd);
    }

    this.spherical.makeSafe();
    this.object.position.setFromSpherical(this.spherical).add(this.target);
    this.object.lookAt(this.target);

    this.checkKeyboardEvents();

    const { needsUpdate } = this;
    this.needsUpdate = false;

    return needsUpdate;
  }
}
