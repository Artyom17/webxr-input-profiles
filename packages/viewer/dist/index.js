import { fetchProfile, MotionController, fetchProfilesList, Constants as Constants$1 } from './motion-controllers.module.js';
import './ajv/ajv.min.js';
import mergeProfile from './assetTools/mergeProfile.js';
import validateRegistryProfile from './registryTools/validateRegistryProfile.js';
import { PerspectiveCamera, Scene, Color, WebGLRenderer, DirectionalLight, SphereGeometry, MeshBasicMaterial, Mesh, Quaternion } from './three/build/three.module.js';
import { GLTFLoader } from './three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from './three/examples/jsm/controls/OrbitControls.js';

const Constants = {
  Handedness: Object.freeze({
    NONE: 'none',
    LEFT: 'left',
    RIGHT: 'right'
  }),

  ComponentState: Object.freeze({
    DEFAULT: 'default',
    TOUCHED: 'touched',
    PRESSED: 'pressed'
  }),

  ComponentProperty: Object.freeze({
    BUTTON: 'button',
    X_AXIS: 'x-axis',
    Y_AXIS: 'y-axis',
    STATE: 'state'
  }),

  ComponentType: Object.freeze({
    TRIGGER: 'trigger',
    SQUEEZE: 'squeeze',
    TOUCHPAD: 'touchpad',
    THUMBSTICK: 'thumbstick',
    BUTTON: 'button'
  }),

  ButtonTouchThreshold: 0.05,

  AxisTouchThreshold: 0.1
};

/**
 * A false gamepad to be used in tests
 */
class MockGamepad {
  /**
   * @param {Object} profileDescription - The profile description to parse to determine the length
   * of the button and axes arrays
   * @param {string} handedness - The gamepad's handedness
   */
  constructor(profileDescription, handedness) {
    if (!profileDescription) {
      throw new Error('No profileDescription supplied');
    }

    if (!handedness) {
      throw new Error('No handedness supplied');
    }

    this.id = profileDescription.profileId;

    // Loop through the profile description to determine how many elements to put in the buttons
    // and axes arrays
    let maxButtonIndex = 0;
    let maxAxisIndex = 0;
    const layout = profileDescription.layouts[handedness];
    this.mapping = layout.mapping;
    Object.values(layout.components).forEach(({ gamepadIndices }) => {
      const {
        [Constants.ComponentProperty.BUTTON]: buttonIndex,
        [Constants.ComponentProperty.X_AXIS]: xAxisIndex,
        [Constants.ComponentProperty.Y_AXIS]: yAxisIndex
      } = gamepadIndices;

      if (buttonIndex !== undefined && buttonIndex > maxButtonIndex) {
        maxButtonIndex = buttonIndex;
      }

      if (xAxisIndex !== undefined && (xAxisIndex > maxAxisIndex)) {
        maxAxisIndex = xAxisIndex;
      }

      if (yAxisIndex !== undefined && (yAxisIndex > maxAxisIndex)) {
        maxAxisIndex = yAxisIndex;
      }
    });

    // Fill the axes array
    this.axes = [];
    while (this.axes.length <= maxAxisIndex) {
      this.axes.push(0);
    }

    // Fill the buttons array
    this.buttons = [];
    while (this.buttons.length <= maxButtonIndex) {
      this.buttons.push({
        value: 0,
        touched: false,
        pressed: false
      });
    }
  }
}

/**
 * A fake XRInputSource that can be used to initialize a MotionController
 */
class MockXRInputSource {
  /**
   * @param {Object} gamepad - The Gamepad object that provides the button and axis data
   * @param {string} handedness - The handedness to report
   */
  constructor(gamepad, handedness) {
    this.gamepad = gamepad;

    if (!handedness) {
      throw new Error('No handedness supplied');
    }

    this.handedness = handedness;
    this.profiles = Object.freeze([this.gamepad.id]);
  }
}

const errorsElementId = 'errors';
let listElement;

function toggleVisibility() {
  const errorsElement = document.getElementById(errorsElementId);
  errorsElement.hidden = errorsElement.children.length === 0;
}

function addErrorElement(errorMessage) {
  const errorsElement = document.getElementById(errorsElementId);
  if (!listElement) {
    listElement = document.createElement('ul');
    errorsElement.appendChild(listElement);
  }

  const itemElement = document.createElement('li');
  itemElement.innerText = errorMessage;
  listElement.appendChild(itemElement);

  toggleVisibility();
}

const ErrorLogging = {
  log: (errorMessage) => {
    addErrorElement(errorMessage);

    /* eslint-disable-next-line no-console */
    console.error(errorMessage);
  },

  throw: (errorMessage) => {
    addErrorElement(errorMessage);
    throw new Error(errorMessage);
  },

  clear: () => {
    if (listElement) {
      const errorsElement = document.getElementById(errorsElementId);
      errorsElement.removeChild(listElement);
      listElement = undefined;
    }
    toggleVisibility();
  },

  clearAll: () => {
    const errorsElement = document.getElementById(errorsElementId);
    errorsElement.innerHTML = '';
    listElement = undefined;
    toggleVisibility();
  }
};

/**
 * Adds a selector for choosing the handedness of the provided profile
 */
class HandednessSelector {
  constructor(parentSelectorType) {
    this.selectorType = parentSelectorType;

    // Create the handedness selector and watch for changes
    this.element = document.createElement('select');
    this.element.id = `${this.selectorType}HandednessSelector`;
    this.element.addEventListener('change', () => { this.onHandednessSelected(); });

    this.clearSelectedProfile();
  }

  /**
   * Fires an event notifying that the handedness has changed
   */
  fireHandednessChange() {
    const changeEvent = new CustomEvent('handednessChange', { detail: this.handedness });
    this.element.dispatchEvent(changeEvent);
  }

  clearSelectedProfile() {
    this.selectedProfile = null;
    this.handedness = null;
    this.handednessStorageKey = null;
    this.element.disabled = true;
    this.element.innerHTML = '<option value="loading">Loading...</option>';
    this.fireHandednessChange();
  }

  /**
   * Responds to changes in the dropdown, saves the value to local storage, and triggers the event
   */
  onHandednessSelected() {
    // Create a mock gamepad that matches the profile and handedness
    this.handedness = this.element.value;
    window.localStorage.setItem(this.handednessStorageKey, this.handedness);
    this.fireHandednessChange();
  }

  /**
   * Sets the profile from which handedness needs to be selected
   * @param {object} profile
   */
  setSelectedProfile(profile) {
    this.clearSelectedProfile();
    this.selectedProfile = profile;

    // Load and clear the last selection for this profile id
    this.handednessStorageKey = `${this.selectorType}_${this.selectedProfile.id}_handedness`;
    const storedHandedness = window.localStorage.getItem(this.handednessStorageKey);
    window.localStorage.removeItem(this.handednessStorageKey);

    // Populate handedness selector
    this.element.innerHTML = '';
    Object.keys(this.selectedProfile.layouts).forEach((handedness) => {
      this.element.innerHTML += `
        <option value='${handedness}'>${handedness}</option>
      `;
    });

    if (this.element.children.length === 0) {
      ErrorLogging.log(`No handedness values found for profile ${this.selectedProfile.id}`);
    }

    // Apply stored handedness if found
    if (storedHandedness && this.selectedProfile.layouts[storedHandedness]) {
      this.element.value = storedHandedness;
    }

    // Manually trigger the handedness to change
    this.element.disabled = false;
    this.onHandednessSelected();
  }
}

/* eslint-disable import/no-unresolved */

const profileIdStorageKey = 'repository_profileId';
const profilesBasePath = './profiles';
/**
 * Loads profiles from the distribution folder next to the viewer's location
 */
class RepositorySelector {
  constructor() {
    this.element = document.getElementById('repository');

    // Get the profile id dropdown and listen for changes
    this.profileIdSelectorElement = document.getElementById('repositoryProfileIdSelector');
    this.profileIdSelectorElement.addEventListener('change', () => { this.onProfileIdSelected(); });

    // Add a handedness selector and listen for changes
    this.handednessSelector = new HandednessSelector('repository');
    this.element.appendChild(this.handednessSelector.element);
    this.handednessSelector.element.addEventListener('handednessChange', (event) => { this.onHandednessChange(event); });

    this.disabled = true;
    this.clearSelectedProfile();
  }

  enable() {
    this.element.hidden = false;
    this.disabled = false;
    this.populateProfileSelector();
  }

  disable() {
    this.element.hidden = true;
    this.disabled = true;
    this.clearSelectedProfile();
  }

  clearSelectedProfile() {
    ErrorLogging.clearAll();
    this.selectedProfile = null;
    this.profileIdSelectorElement.disabled = true;
    this.handednessSelector.clearSelectedProfile();
  }

  /**
   * Responds to changes in selected handedness.
   * Creates a new motion controller for the combination of profile and handedness, and fires an
   * event to signal the change
   * @param {object} event
   */
  onHandednessChange(event) {
    if (!this.disabled) {
      let motionController;
      const handedness = event.detail;

      // Create motion controller if a handedness has been selected
      if (handedness) {
        const mockGamepad = new MockGamepad(this.selectedProfile, handedness);
        const mockXRInputSource = new MockXRInputSource(mockGamepad, handedness);

        fetchProfile(mockXRInputSource, profilesBasePath).then(({ profile, assetPath }) => {
          motionController = new MotionController(
            mockXRInputSource,
            profile,
            assetPath
          );

          // Signal the change
          const changeEvent = new CustomEvent(
            'motionControllerChange',
            { detail: motionController }
          );
          this.element.dispatchEvent(changeEvent);
        });
      } else {
        // Signal the change
        const changeEvent = new CustomEvent('motionControllerChange', { detail: null });
        this.element.dispatchEvent(changeEvent);
      }
    }
  }

  /**
   * Handler for the profile id selection change
   */
  onProfileIdSelected() {
    this.clearSelectedProfile();

    const profileId = this.profileIdSelectorElement.value;
    window.localStorage.setItem(profileIdStorageKey, profileId);

    // Attempt to load the profile
    fetchProfile({ profiles: [profileId] }, profilesBasePath, false).then(({ profile }) => {
      this.selectedProfile = profile;
      this.handednessSelector.setSelectedProfile(this.selectedProfile);
    })
      .catch((error) => {
        ErrorLogging.log(error.message);
        throw error;
      })
      .finally(() => {
        this.profileIdSelectorElement.disabled = false;
      });
  }

  /**
   * Retrieves the full list of available profiles
   */
  populateProfileSelector() {
    this.clearSelectedProfile();

    // Load and clear local storage
    const storedProfileId = window.localStorage.getItem(profileIdStorageKey);
    window.localStorage.removeItem(profileIdStorageKey);

    // Load the list of profiles
    this.profileIdSelectorElement.innerHTML = '<option value="loading">Loading...</option>';
    fetchProfilesList(profilesBasePath).then((profilesList) => {
      this.profileIdSelectorElement.innerHTML = '';
      Object.keys(profilesList).forEach((profileId) => {
        this.profileIdSelectorElement.innerHTML += `
        <option value='${profileId}'>${profileId}</option>
        `;
      });

      // Override the default selection if values were present in local storage
      if (storedProfileId) {
        this.profileIdSelectorElement.value = storedProfileId;
      }

      // Manually trigger selected profile to load
      this.onProfileIdSelected();
    })
      .catch((error) => {
        ErrorLogging.log(error.message);
        throw error;
      });
  }
}

/* eslint-disable import/no-unresolved */

/**
 * Loads selected file from filesystem and sets it as the selected profile
 * @param {Object} jsonFile
 */
function loadLocalJson(jsonFile) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const json = JSON.parse(reader.result);
      resolve(json);
    };

    reader.onerror = () => {
      const errorMessage = `Unable to load JSON from ${jsonFile.name}`;
      ErrorLogging.log(errorMessage);
      reject(errorMessage);
    };

    reader.readAsText(jsonFile);
  });
}

async function buildSchemaValidator(schemasPath) {
  const response = await fetch(schemasPath);
  if (!response.ok) {
    ErrorLogging.throw(response.statusText);
  }

  // eslint-disable-next-line no-undef
  const ajv = new Ajv();
  const schemas = await response.json();
  schemas.dependencies.forEach((schema) => {
    ajv.addSchema(schema);
  });

  return ajv.compile(schemas.mainSchema);
}

/**
 * Loads a profile from a set of local files
 */
class LocalProfileSelector {
  constructor() {
    this.element = document.getElementById('localProfile');
    this.localFilesListElement = document.getElementById('localFilesList');

    // Get the assets selector and watch for changes
    this.registryJsonSelector = document.getElementById('localProfileRegistryJsonSelector');
    this.registryJsonSelector.addEventListener('change', () => { this.onRegistryJsonSelected(); });

    // Get the asset json  selector and watch for changes
    this.assetJsonSelector = document.getElementById('localProfileAssetJsonSelector');
    this.assetJsonSelector.addEventListener('change', () => { this.onAssetJsonSelected(); });

    // Get the registry json selector and watch for changes
    this.assetsSelector = document.getElementById('localProfileAssetsSelector');
    this.assetsSelector.addEventListener('change', () => { this.onAssetsSelected(); });

    // Add a handedness selector and listen for changes
    this.handednessSelector = new HandednessSelector('localProfile');
    this.handednessSelector.element.addEventListener('handednessChange', (event) => { this.onHandednessChange(event); });
    this.element.insertBefore(this.handednessSelector.element, this.localFilesListElement);

    this.disabled = true;

    this.clearSelectedProfile();

    buildSchemaValidator('registryTools/registrySchemas.json').then((registrySchemaValidator) => {
      this.registrySchemaValidator = registrySchemaValidator;
      buildSchemaValidator('assetTools/assetSchemas.json').then((assetSchemaValidator) => {
        this.assetSchemaValidator = assetSchemaValidator;
        // TODO figure out disabled thing
        this.onRegistryJsonSelected();
        this.onAssetJsonSelected();
        this.onAssetsSelected();
      });
    });
  }

  enable() {
    this.element.hidden = false;
    this.disabled = false;
  }

  disable() {
    this.element.hidden = true;
    this.disabled = true;
    this.clearSelectedProfile();
  }

  clearSelectedProfile() {
    ErrorLogging.clearAll();
    this.registryJson = null;
    this.assetJson = null;
    this.mergedProfile = null;
    this.assets = [];
    this.handednessSelector.clearSelectedProfile();
  }

  createMotionController() {
    let motionController;
    if (this.handednessSelector.handedness && this.mergedProfile) {
      const { handedness } = this.handednessSelector;
      const mockGamepad = new MockGamepad(this.mergedProfile, handedness);
      const mockXRInputSource = new MockXRInputSource(mockGamepad, handedness);

      const assetName = this.mergedProfile.layouts[handedness].path;
      const assetUrl = this.assets[assetName];
      motionController = new MotionController(mockXRInputSource, this.mergedProfile, assetUrl);
    }

    const changeEvent = new CustomEvent('motionControllerChange', { detail: motionController });
    this.element.dispatchEvent(changeEvent);
  }

  /**
   * Responds to changes in selected handedness.
   * Creates a new motion controller for the combination of profile and handedness, and fires an
   * event to signal the change
   * @param {object} event
   */
  onHandednessChange() {
    if (!this.disabled) {
      this.createMotionController();
    }
  }

  async mergeJsonProfiles() {
    if (this.registryJson && this.assetJson) {
      try {
        this.mergedProfile = mergeProfile(this.registryJson, this.assetJson);
        this.handednessSelector.setSelectedProfile(this.mergedProfile);
      } catch (error) {
        ErrorLogging.log(error);
        throw error;
      }
    }
  }

  onRegistryJsonSelected() {
    if (!this.element.disabled) {
      this.registryJson = null;
      this.mergedProfile = null;
      this.handednessSelector.clearSelectedProfile();
      if (this.registryJsonSelector.files.length > 0) {
        loadLocalJson(this.registryJsonSelector.files[0]).then((registryJson) => {
          const valid = this.registrySchemaValidator(registryJson);
          if (!valid) {
            ErrorLogging.log(JSON.stringify(this.registrySchemaValidator.errors, null, 2));
          } else {
            try {
              validateRegistryProfile(registryJson);
            } catch (error) {
              ErrorLogging.log(error);
              throw error;
            }
            this.registryJson = registryJson;
            this.mergeJsonProfiles();
          }
        });
      }
    }
  }

  onAssetJsonSelected() {
    if (!this.element.disabled) {
      this.assetJson = null;
      this.mergedProfile = null;
      this.handednessSelector.clearSelectedProfile();
      if (this.assetJsonSelector.files.length > 0) {
        loadLocalJson(this.assetJsonSelector.files[0]).then((assetJson) => {
          const valid = this.assetSchemaValidator(assetJson);
          if (!valid) {
            ErrorLogging.log(JSON.stringify(this.assetSchemaValidator.errors, null, 2));
          } else {
            this.assetJson = assetJson;
            this.mergeJsonProfiles();
          }
        });
      }
    }
  }

  /**
   * Handles changes to the set of local files selected
   */
  onAssetsSelected() {
    if (!this.element.disabled) {
      const fileList = Array.from(this.assetsSelector.files);
      this.assets = [];
      fileList.forEach((file) => {
        this.assets[file.name] = window.URL.createObjectURL(file);
      });
      this.createMotionController();
    }
  }
}

/* eslint-disable import/no-unresolved */

const three = {};
let canvasParentElement;
let activeModel;

/**
 * @description Attaches a small blue sphere to the point reported as touched on all touchpads
 * @param {Object} model - The model to add dots to
 * @param {Object} motionController - A MotionController to be displayed and animated
 * @param {Object} rootNode - The root node in the asset to be animated
 */
function addTouchDots({ motionController, rootNode }) {
  Object.keys(motionController.components).forEach((componentId) => {
    const component = motionController.components[componentId];
    // Find the touchpads
    if (component.type === Constants$1.ComponentType.TOUCHPAD) {
      // Find the node to attach the touch dot.
      const componentRoot = rootNode.getObjectByName(component.rootNodeName, true);

      if (!componentRoot) {
        ErrorLogging.log(`Could not find root node of touchpad component ${component.rootNodeName}`);
        return;
      }

      const touchPointRoot = componentRoot.getObjectByName(component.touchPointNodeName, true);
      if (!touchPointRoot) {
        ErrorLogging.log(`Could not find touch dot, ${component.touchPointNodeName}, in touchpad component ${componentId}`);
      } else {
        const sphereGeometry = new SphereGeometry(0.001);
        const material = new MeshBasicMaterial({ color: 0x0000FF });
        const sphere = new Mesh(sphereGeometry, material);
        touchPointRoot.add(sphere);
      }
    }
  });
}

/**
 * @description Walks the model's tree to find the nodes needed to animate the components and
 * saves them for use in the frame loop
 * @param {Object} model - The model to find nodes in
 */
function findNodes(model) {
  const nodes = {};

  // Loop through the components and find the nodes needed for each components' visual responses
  Object.values(model.motionController.components).forEach((component) => {
    const componentRootNode = model.rootNode.getObjectByName(component.rootNodeName, true);
    const componentNodes = {};

    // If the root node cannot be found, skip this component
    if (!componentRootNode) {
      ErrorLogging.log(`Could not find root node of component ${component.rootNodeName}`);
      return;
    }

    // Loop through all the visual responses to be applied to this component
    Object.values(component.visualResponses).forEach((visualResponse) => {
      const visualResponseNodes = {};
      const { rootNodeName, targetNodeName, property } = visualResponse.description;

      // Find the node at the top of the visualization
      if (rootNodeName === component.root) {
        visualResponseNodes.rootNode = componentRootNode;
      } else {
        visualResponseNodes.rootNode = componentRootNode.getObjectByName(rootNodeName, true);
      }

      // If the root node cannot be found, skip this animation
      if (!visualResponseNodes.rootNode) {
        ErrorLogging.log(`Could not find root node of visual response for ${rootNodeName}`);
        return;
      }

      // Find the node to be changed
      visualResponseNodes.targetNode = visualResponseNodes.rootNode.getObjectByName(targetNodeName);

      // If animating a transform, find the two nodes to be interpolated between.
      if (property === 'transform') {
        const { minNodeName, maxNodeName } = visualResponse.description;
        visualResponseNodes.minNode = visualResponseNodes.rootNode.getObjectByName(minNodeName);
        visualResponseNodes.maxNode = visualResponseNodes.rootNode.getObjectByName(maxNodeName);

        // If the extents cannot be found, skip this animation
        if (!visualResponseNodes.minNode || !visualResponseNodes.maxNode) {
          ErrorLogging.log(`Could not find extents nodes of visual response for ${rootNodeName}`);
          return;
        }
      }

      // Add the animation to the component's nodes dictionary
      componentNodes[rootNodeName] = visualResponseNodes;
    });

    // Add the component's animations to the controller's nodes dictionary
    nodes[component.id] = componentNodes;
  });

  return nodes;
}


function clear() {
  if (activeModel) {
    // Remove any existing model from the scene
    three.scene.remove(activeModel.rootNode);
    activeModel = null;
  }

  ErrorLogging.clear();
}
/**
 * @description Event handler for window resizing.
 */
function onResize() {
  const width = canvasParentElement.clientWidth;
  const height = canvasParentElement.clientHeight;
  three.camera.aspectRatio = width / height;
  three.camera.updateProjectionMatrix();
  three.renderer.setSize(width, height);
  three.controls.update();
}

/**
 * @description Callback which runs the rendering loop. (Passed into window.requestAnimationFrame)
 */
function animationFrameCallback() {
  window.requestAnimationFrame(animationFrameCallback);

  if (activeModel) {
    // Cause the MotionController to poll the Gamepad for data
    activeModel.motionController.updateFromGamepad();

    // Update the 3D model to reflect the button, thumbstick, and touchpad state
    Object.values(activeModel.motionController.components).forEach((component) => {
      const componentNodes = activeModel.nodes[component.id];

      // Skip if the component node is not found. No error is needed, because it
      // will have been reported at load time.
      if (!componentNodes) return;

      // Update node data based on the visual responses' current states
      Object.values(component.visualResponses).forEach((visualResponse) => {
        const { description, value } = visualResponse;
        const visualResponseNodes = componentNodes[description.rootNodeName];

        // Skip if the visual response node is not found. No error is needed,
        // because it will have been reported at load time.
        if (!visualResponseNodes) return;

        // Calculate the new properties based on the weight supplied
        if (description.property === 'visibility') {
          visualResponseNodes.targetNode.visible = value;
        } else if (description.property === 'transform') {
          Quaternion.slerp(
            visualResponseNodes.minNode.quaternion,
            visualResponseNodes.maxNode.quaternion,
            visualResponseNodes.targetNode.quaternion,
            value
          );

          visualResponseNodes.targetNode.position.lerpVectors(
            visualResponseNodes.minNode.position,
            visualResponseNodes.maxNode.position,
            value
          );
        }
      });
    });
  }

  three.renderer.render(three.scene, three.camera);
  three.controls.update();
}

const ModelViewer = {
  initialize: () => {
    canvasParentElement = document.getElementById('modelViewer');
    const width = canvasParentElement.clientWidth;
    const height = canvasParentElement.clientHeight;

    // Set up the THREE.js infrastructure
    three.camera = new PerspectiveCamera(75, width / height, 0.01, 1000);
    three.camera.position.y = 0.5;
    three.scene = new Scene();
    three.scene.background = new Color(0x00aa44);
    three.renderer = new WebGLRenderer({ antialias: true });
    three.renderer.setSize(width, height);
    three.renderer.gammaOutput = true;
    three.loader = new GLTFLoader();

    // Set up the controls for moving the scene around
    three.controls = new OrbitControls(three.camera, three.renderer.domElement);
    three.controls.enableDamping = true;
    three.controls.minDistance = 0.05;
    three.controls.maxDistance = 0.3;
    three.controls.enablePan = false;
    three.controls.update();

    // Set up the lights so the model can be seen
    const bottomDirectionalLight = new DirectionalLight(0xFFFFFF, 2);
    bottomDirectionalLight.position.set(0, -1, 0);
    three.scene.add(bottomDirectionalLight);
    const topDirectionalLight = new DirectionalLight(0xFFFFFF, 2);
    three.scene.add(topDirectionalLight);

    // Add the THREE.js canvas to the page
    canvasParentElement.appendChild(three.renderer.domElement);
    window.addEventListener('resize', onResize, false);

    // Start pumping frames
    window.requestAnimationFrame(animationFrameCallback);
  },

  loadModel: async (motionController) => {
    try {
      const gltfAsset = await new Promise(((resolve, reject) => {
        three.loader.load(
          motionController.assetUrl,
          (loadedAsset) => { resolve(loadedAsset); },
          null,
          () => { reject(new Error(`Asset ${motionController.assetUrl} missing or malformed.`)); }
        );
      }));

      // Remove any existing model from the scene
      clear();

      const model = {
        motionController,
        rootNode: gltfAsset.scene
      };

      model.nodes = findNodes(model);
      addTouchDots(model);

      // Set the new model
      activeModel = model;
      three.scene.add(activeModel.rootNode);
    } catch (error) {
      ErrorLogging.throw(error);
    }
  },

  clear
};

/* eslint-disable import/no-unresolved */
/* eslint-enable */

let motionController;
let mockGamepad;
let controlsListElement;

function animationFrameCallback$1() {
  if (motionController) {
    Object.values(motionController.components).forEach((component) => {
      const dataElement = document.getElementById(`${component.id}_data`);
      dataElement.innerHTML = JSON.stringify(component.data, null, 2);
    });
    window.requestAnimationFrame(animationFrameCallback$1);
  }
}

function onButtonTouched(event) {
  const { index } = event.target.dataset;
  mockGamepad.buttons[index].touched = event.target.checked;
}

function onButtonPressed(event) {
  const { index } = event.target.dataset;
  mockGamepad.buttons[index].pressed = event.target.checked;
}

function onButtonValueChange(event) {
  const { index } = event.target.dataset;
  mockGamepad.buttons[index].value = Number(event.target.value);
}

function onAxisValueChange(event) {
  const { index } = event.target.dataset;
  mockGamepad.axes[index] = Number(event.target.value);
}

function clear$1() {
  motionController = undefined;
  mockGamepad = undefined;

  if (!controlsListElement) {
    controlsListElement = document.getElementById('controlsList');
  }
  controlsListElement.innerHTML = '';
}

function addButtonControls(componentControlsElement, buttonIndex) {
  const buttonControlsElement = document.createElement('div');
  buttonControlsElement.setAttribute('class', 'componentControls');

  buttonControlsElement.innerHTML += `
  <label>buttonValue</label>
  <input id="buttons[${buttonIndex}].value" data-index="${buttonIndex}" type="range" min="0" max="1" step="0.01" value="0">
  
  <label>touched</label>
  <input id="buttons[${buttonIndex}].touched" data-index="${buttonIndex}" type="checkbox">

  <label>pressed</label>
  <input id="buttons[${buttonIndex}].pressed" data-index="${buttonIndex}" type="checkbox">
  `;

  componentControlsElement.appendChild(buttonControlsElement);

  document.getElementById(`buttons[${buttonIndex}].value`).addEventListener('input', onButtonValueChange);
  document.getElementById(`buttons[${buttonIndex}].touched`).addEventListener('click', onButtonTouched);
  document.getElementById(`buttons[${buttonIndex}].pressed`).addEventListener('click', onButtonPressed);
}

function addAxisControls(componentControlsElement, axisName, axisIndex) {
  const axisControlsElement = document.createElement('div');
  axisControlsElement.setAttribute('class', 'componentControls');

  axisControlsElement.innerHTML += `
  <label>${axisName}<label>
  <input id="axes[${axisIndex}]" data-index="${axisIndex}"
          type="range" min="-1" max="1" step="0.01" value="0">
  `;

  componentControlsElement.appendChild(axisControlsElement);

  document.getElementById(`axes[${axisIndex}]`).addEventListener('input', onAxisValueChange);
}

function build(sourceMotionController) {
  clear$1();

  motionController = sourceMotionController;
  mockGamepad = motionController.xrInputSource.gamepad;

  Object.values(motionController.components).forEach((component) => {
    const {
      [Constants$1.ComponentProperty.BUTTON]: buttonIndex,
      [Constants$1.ComponentProperty.X_AXIS]: xAxisIndex,
      [Constants$1.ComponentProperty.Y_AXIS]: yAxisIndex
    } = component.description.gamepadIndices;

    const componentControlsElement = document.createElement('li');
    componentControlsElement.setAttribute('class', 'component');
    controlsListElement.appendChild(componentControlsElement);

    const headingElement = document.createElement('h4');
    headingElement.innerText = `${component.id}`;
    componentControlsElement.appendChild(headingElement);

    if (buttonIndex !== undefined) {
      addButtonControls(componentControlsElement, buttonIndex);
    }

    if (xAxisIndex !== undefined) {
      addAxisControls(componentControlsElement, 'xAxis', xAxisIndex);
    }

    if (yAxisIndex !== undefined) {
      addAxisControls(componentControlsElement, 'yAxis', yAxisIndex);
    }

    const dataElement = document.createElement('pre');
    dataElement.id = `${component.id}_data`;
    componentControlsElement.appendChild(dataElement);

    window.requestAnimationFrame(animationFrameCallback$1);
  });
}

var ManualControls = { clear: clear$1, build };

const selectorIdStorageKey = 'selectorId';
const selectors = {};
let activeSelector;

/**
 * Updates the controls and model viewer when the selected motion controller changes
 * @param {Object} event
 */
function onMotionControllerChange(event) {
  if (event.target === activeSelector.element) {
    ErrorLogging.clearAll();
    if (!event.detail) {
      ModelViewer.clear();
      ManualControls.clear();
    } else {
      const motionController = event.detail;
      ManualControls.build(motionController);
      ModelViewer.loadModel(motionController);
    }
  }
}

/**
 * Handles the selection source radio button change
 */
function onRadioChange() {
  ManualControls.clear();
  ModelViewer.clear();

  // Figure out which item is now selected
  const selectedQuery = 'input[name = "sourceSelector"]:checked';
  const selectorType = document.querySelector(selectedQuery).value;

  // Disable the previous selection source
  if (activeSelector) {
    activeSelector.disable();
  }

  // Start using the new selection source
  activeSelector = selectors[selectorType];
  activeSelector.enable();
  window.localStorage.setItem(selectorIdStorageKey, selectorType);
}

function onLoad() {
  ModelViewer.initialize();

  // Hook up event listeners to the radio buttons
  const repositoryRadioButton = document.getElementById('repositoryRadioButton');
  const localProfileRadioButton = document.getElementById('localProfileRadioButton');
  repositoryRadioButton.addEventListener('change', onRadioChange);
  localProfileRadioButton.addEventListener('change', onRadioChange);

  // Check if the page has stored a choice of selection source
  const storedSelectorId = window.localStorage.getItem(selectorIdStorageKey);
  const radioButtonToSelect = document.querySelector(`input[value = "${storedSelectorId}"]`);
  if (radioButtonToSelect) {
    radioButtonToSelect.checked = true;
  }

  // Create the objects to select motion controllers based on user input
  selectors.repository = new RepositorySelector();
  selectors.localProfile = new LocalProfileSelector();
  Object.values(selectors).forEach((selector) => {
    selector.element.addEventListener('motionControllerChange', onMotionControllerChange);
  });

  // manually trigger first check
  onRadioChange();
}
window.addEventListener('load', onLoad);
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VzIjpbIi4uLy4uL21vdGlvbi1jb250cm9sbGVycy9zcmMvY29uc3RhbnRzLmpzIiwiLi4vc3JjL21vY2tzL21vY2tHYW1lcGFkLmpzIiwiLi4vc3JjL21vY2tzL21vY2tYUklucHV0U291cmNlLmpzIiwiLi4vc3JjL2Vycm9yTG9nZ2luZy5qcyIsIi4uL3NyYy9oYW5kZWRuZXNzU2VsZWN0b3IuanMiLCIuLi9zcmMvcmVwb3NpdG9yeVNlbGVjdG9yLmpzIiwiLi4vc3JjL2xvY2FsUHJvZmlsZVNlbGVjdG9yLmpzIiwiLi4vc3JjL21vZGVsVmlld2VyLmpzIiwiLi4vc3JjL21hbnVhbENvbnRyb2xzLmpzIiwiLi4vc3JjL2luZGV4LmpzIl0sInNvdXJjZXNDb250ZW50IjpbImNvbnN0IENvbnN0YW50cyA9IHtcbiAgSGFuZGVkbmVzczogT2JqZWN0LmZyZWV6ZSh7XG4gICAgTk9ORTogJ25vbmUnLFxuICAgIExFRlQ6ICdsZWZ0JyxcbiAgICBSSUdIVDogJ3JpZ2h0J1xuICB9KSxcblxuICBDb21wb25lbnRTdGF0ZTogT2JqZWN0LmZyZWV6ZSh7XG4gICAgREVGQVVMVDogJ2RlZmF1bHQnLFxuICAgIFRPVUNIRUQ6ICd0b3VjaGVkJyxcbiAgICBQUkVTU0VEOiAncHJlc3NlZCdcbiAgfSksXG5cbiAgQ29tcG9uZW50UHJvcGVydHk6IE9iamVjdC5mcmVlemUoe1xuICAgIEJVVFRPTjogJ2J1dHRvbicsXG4gICAgWF9BWElTOiAneC1heGlzJyxcbiAgICBZX0FYSVM6ICd5LWF4aXMnLFxuICAgIFNUQVRFOiAnc3RhdGUnXG4gIH0pLFxuXG4gIENvbXBvbmVudFR5cGU6IE9iamVjdC5mcmVlemUoe1xuICAgIFRSSUdHRVI6ICd0cmlnZ2VyJyxcbiAgICBTUVVFRVpFOiAnc3F1ZWV6ZScsXG4gICAgVE9VQ0hQQUQ6ICd0b3VjaHBhZCcsXG4gICAgVEhVTUJTVElDSzogJ3RodW1ic3RpY2snLFxuICAgIEJVVFRPTjogJ2J1dHRvbidcbiAgfSksXG5cbiAgQnV0dG9uVG91Y2hUaHJlc2hvbGQ6IDAuMDUsXG5cbiAgQXhpc1RvdWNoVGhyZXNob2xkOiAwLjFcbn07XG5cbmV4cG9ydCBkZWZhdWx0IENvbnN0YW50cztcbiIsImltcG9ydCBDb25zdGFudHMgZnJvbSAnLi4vLi4vLi4vbW90aW9uLWNvbnRyb2xsZXJzL3NyYy9jb25zdGFudHMuanMnO1xuXG4vKipcbiAqIEEgZmFsc2UgZ2FtZXBhZCB0byBiZSB1c2VkIGluIHRlc3RzXG4gKi9cbmNsYXNzIE1vY2tHYW1lcGFkIHtcbiAgLyoqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBwcm9maWxlRGVzY3JpcHRpb24gLSBUaGUgcHJvZmlsZSBkZXNjcmlwdGlvbiB0byBwYXJzZSB0byBkZXRlcm1pbmUgdGhlIGxlbmd0aFxuICAgKiBvZiB0aGUgYnV0dG9uIGFuZCBheGVzIGFycmF5c1xuICAgKiBAcGFyYW0ge3N0cmluZ30gaGFuZGVkbmVzcyAtIFRoZSBnYW1lcGFkJ3MgaGFuZGVkbmVzc1xuICAgKi9cbiAgY29uc3RydWN0b3IocHJvZmlsZURlc2NyaXB0aW9uLCBoYW5kZWRuZXNzKSB7XG4gICAgaWYgKCFwcm9maWxlRGVzY3JpcHRpb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gcHJvZmlsZURlc2NyaXB0aW9uIHN1cHBsaWVkJyk7XG4gICAgfVxuXG4gICAgaWYgKCFoYW5kZWRuZXNzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIGhhbmRlZG5lc3Mgc3VwcGxpZWQnKTtcbiAgICB9XG5cbiAgICB0aGlzLmlkID0gcHJvZmlsZURlc2NyaXB0aW9uLnByb2ZpbGVJZDtcblxuICAgIC8vIExvb3AgdGhyb3VnaCB0aGUgcHJvZmlsZSBkZXNjcmlwdGlvbiB0byBkZXRlcm1pbmUgaG93IG1hbnkgZWxlbWVudHMgdG8gcHV0IGluIHRoZSBidXR0b25zXG4gICAgLy8gYW5kIGF4ZXMgYXJyYXlzXG4gICAgbGV0IG1heEJ1dHRvbkluZGV4ID0gMDtcbiAgICBsZXQgbWF4QXhpc0luZGV4ID0gMDtcbiAgICBjb25zdCBsYXlvdXQgPSBwcm9maWxlRGVzY3JpcHRpb24ubGF5b3V0c1toYW5kZWRuZXNzXTtcbiAgICB0aGlzLm1hcHBpbmcgPSBsYXlvdXQubWFwcGluZztcbiAgICBPYmplY3QudmFsdWVzKGxheW91dC5jb21wb25lbnRzKS5mb3JFYWNoKCh7IGdhbWVwYWRJbmRpY2VzIH0pID0+IHtcbiAgICAgIGNvbnN0IHtcbiAgICAgICAgW0NvbnN0YW50cy5Db21wb25lbnRQcm9wZXJ0eS5CVVRUT05dOiBidXR0b25JbmRleCxcbiAgICAgICAgW0NvbnN0YW50cy5Db21wb25lbnRQcm9wZXJ0eS5YX0FYSVNdOiB4QXhpc0luZGV4LFxuICAgICAgICBbQ29uc3RhbnRzLkNvbXBvbmVudFByb3BlcnR5LllfQVhJU106IHlBeGlzSW5kZXhcbiAgICAgIH0gPSBnYW1lcGFkSW5kaWNlcztcblxuICAgICAgaWYgKGJ1dHRvbkluZGV4ICE9PSB1bmRlZmluZWQgJiYgYnV0dG9uSW5kZXggPiBtYXhCdXR0b25JbmRleCkge1xuICAgICAgICBtYXhCdXR0b25JbmRleCA9IGJ1dHRvbkluZGV4O1xuICAgICAgfVxuXG4gICAgICBpZiAoeEF4aXNJbmRleCAhPT0gdW5kZWZpbmVkICYmICh4QXhpc0luZGV4ID4gbWF4QXhpc0luZGV4KSkge1xuICAgICAgICBtYXhBeGlzSW5kZXggPSB4QXhpc0luZGV4O1xuICAgICAgfVxuXG4gICAgICBpZiAoeUF4aXNJbmRleCAhPT0gdW5kZWZpbmVkICYmICh5QXhpc0luZGV4ID4gbWF4QXhpc0luZGV4KSkge1xuICAgICAgICBtYXhBeGlzSW5kZXggPSB5QXhpc0luZGV4O1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gRmlsbCB0aGUgYXhlcyBhcnJheVxuICAgIHRoaXMuYXhlcyA9IFtdO1xuICAgIHdoaWxlICh0aGlzLmF4ZXMubGVuZ3RoIDw9IG1heEF4aXNJbmRleCkge1xuICAgICAgdGhpcy5heGVzLnB1c2goMCk7XG4gICAgfVxuXG4gICAgLy8gRmlsbCB0aGUgYnV0dG9ucyBhcnJheVxuICAgIHRoaXMuYnV0dG9ucyA9IFtdO1xuICAgIHdoaWxlICh0aGlzLmJ1dHRvbnMubGVuZ3RoIDw9IG1heEJ1dHRvbkluZGV4KSB7XG4gICAgICB0aGlzLmJ1dHRvbnMucHVzaCh7XG4gICAgICAgIHZhbHVlOiAwLFxuICAgICAgICB0b3VjaGVkOiBmYWxzZSxcbiAgICAgICAgcHJlc3NlZDogZmFsc2VcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBNb2NrR2FtZXBhZDtcbiIsIi8qKlxuICogQSBmYWtlIFhSSW5wdXRTb3VyY2UgdGhhdCBjYW4gYmUgdXNlZCB0byBpbml0aWFsaXplIGEgTW90aW9uQ29udHJvbGxlclxuICovXG5jbGFzcyBNb2NrWFJJbnB1dFNvdXJjZSB7XG4gIC8qKlxuICAgKiBAcGFyYW0ge09iamVjdH0gZ2FtZXBhZCAtIFRoZSBHYW1lcGFkIG9iamVjdCB0aGF0IHByb3ZpZGVzIHRoZSBidXR0b24gYW5kIGF4aXMgZGF0YVxuICAgKiBAcGFyYW0ge3N0cmluZ30gaGFuZGVkbmVzcyAtIFRoZSBoYW5kZWRuZXNzIHRvIHJlcG9ydFxuICAgKi9cbiAgY29uc3RydWN0b3IoZ2FtZXBhZCwgaGFuZGVkbmVzcykge1xuICAgIHRoaXMuZ2FtZXBhZCA9IGdhbWVwYWQ7XG5cbiAgICBpZiAoIWhhbmRlZG5lc3MpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gaGFuZGVkbmVzcyBzdXBwbGllZCcpO1xuICAgIH1cblxuICAgIHRoaXMuaGFuZGVkbmVzcyA9IGhhbmRlZG5lc3M7XG4gICAgdGhpcy5wcm9maWxlcyA9IE9iamVjdC5mcmVlemUoW3RoaXMuZ2FtZXBhZC5pZF0pO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IE1vY2tYUklucHV0U291cmNlO1xuIiwiY29uc3QgZXJyb3JzRWxlbWVudElkID0gJ2Vycm9ycyc7XG5sZXQgbGlzdEVsZW1lbnQ7XG5cbmZ1bmN0aW9uIHRvZ2dsZVZpc2liaWxpdHkoKSB7XG4gIGNvbnN0IGVycm9yc0VsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChlcnJvcnNFbGVtZW50SWQpO1xuICBlcnJvcnNFbGVtZW50LmhpZGRlbiA9IGVycm9yc0VsZW1lbnQuY2hpbGRyZW4ubGVuZ3RoID09PSAwO1xufVxuXG5mdW5jdGlvbiBhZGRFcnJvckVsZW1lbnQoZXJyb3JNZXNzYWdlKSB7XG4gIGNvbnN0IGVycm9yc0VsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChlcnJvcnNFbGVtZW50SWQpO1xuICBpZiAoIWxpc3RFbGVtZW50KSB7XG4gICAgbGlzdEVsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCd1bCcpO1xuICAgIGVycm9yc0VsZW1lbnQuYXBwZW5kQ2hpbGQobGlzdEVsZW1lbnQpO1xuICB9XG5cbiAgY29uc3QgaXRlbUVsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsaScpO1xuICBpdGVtRWxlbWVudC5pbm5lclRleHQgPSBlcnJvck1lc3NhZ2U7XG4gIGxpc3RFbGVtZW50LmFwcGVuZENoaWxkKGl0ZW1FbGVtZW50KTtcblxuICB0b2dnbGVWaXNpYmlsaXR5KCk7XG59XG5cbmNvbnN0IEVycm9yTG9nZ2luZyA9IHtcbiAgbG9nOiAoZXJyb3JNZXNzYWdlKSA9PiB7XG4gICAgYWRkRXJyb3JFbGVtZW50KGVycm9yTWVzc2FnZSk7XG5cbiAgICAvKiBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZSAqL1xuICAgIGNvbnNvbGUuZXJyb3IoZXJyb3JNZXNzYWdlKTtcbiAgfSxcblxuICB0aHJvdzogKGVycm9yTWVzc2FnZSkgPT4ge1xuICAgIGFkZEVycm9yRWxlbWVudChlcnJvck1lc3NhZ2UpO1xuICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICB9LFxuXG4gIGNsZWFyOiAoKSA9PiB7XG4gICAgaWYgKGxpc3RFbGVtZW50KSB7XG4gICAgICBjb25zdCBlcnJvcnNFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoZXJyb3JzRWxlbWVudElkKTtcbiAgICAgIGVycm9yc0VsZW1lbnQucmVtb3ZlQ2hpbGQobGlzdEVsZW1lbnQpO1xuICAgICAgbGlzdEVsZW1lbnQgPSB1bmRlZmluZWQ7XG4gICAgfVxuICAgIHRvZ2dsZVZpc2liaWxpdHkoKTtcbiAgfSxcblxuICBjbGVhckFsbDogKCkgPT4ge1xuICAgIGNvbnN0IGVycm9yc0VsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChlcnJvcnNFbGVtZW50SWQpO1xuICAgIGVycm9yc0VsZW1lbnQuaW5uZXJIVE1MID0gJyc7XG4gICAgbGlzdEVsZW1lbnQgPSB1bmRlZmluZWQ7XG4gICAgdG9nZ2xlVmlzaWJpbGl0eSgpO1xuICB9XG59O1xuXG5leHBvcnQgZGVmYXVsdCBFcnJvckxvZ2dpbmc7XG4iLCJpbXBvcnQgRXJyb3JMb2dnaW5nIGZyb20gJy4vZXJyb3JMb2dnaW5nLmpzJztcblxuLyoqXG4gKiBBZGRzIGEgc2VsZWN0b3IgZm9yIGNob29zaW5nIHRoZSBoYW5kZWRuZXNzIG9mIHRoZSBwcm92aWRlZCBwcm9maWxlXG4gKi9cbmNsYXNzIEhhbmRlZG5lc3NTZWxlY3RvciB7XG4gIGNvbnN0cnVjdG9yKHBhcmVudFNlbGVjdG9yVHlwZSkge1xuICAgIHRoaXMuc2VsZWN0b3JUeXBlID0gcGFyZW50U2VsZWN0b3JUeXBlO1xuXG4gICAgLy8gQ3JlYXRlIHRoZSBoYW5kZWRuZXNzIHNlbGVjdG9yIGFuZCB3YXRjaCBmb3IgY2hhbmdlc1xuICAgIHRoaXMuZWxlbWVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NlbGVjdCcpO1xuICAgIHRoaXMuZWxlbWVudC5pZCA9IGAke3RoaXMuc2VsZWN0b3JUeXBlfUhhbmRlZG5lc3NTZWxlY3RvcmA7XG4gICAgdGhpcy5lbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHsgdGhpcy5vbkhhbmRlZG5lc3NTZWxlY3RlZCgpOyB9KTtcblxuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGaXJlcyBhbiBldmVudCBub3RpZnlpbmcgdGhhdCB0aGUgaGFuZGVkbmVzcyBoYXMgY2hhbmdlZFxuICAgKi9cbiAgZmlyZUhhbmRlZG5lc3NDaGFuZ2UoKSB7XG4gICAgY29uc3QgY2hhbmdlRXZlbnQgPSBuZXcgQ3VzdG9tRXZlbnQoJ2hhbmRlZG5lc3NDaGFuZ2UnLCB7IGRldGFpbDogdGhpcy5oYW5kZWRuZXNzIH0pO1xuICAgIHRoaXMuZWxlbWVudC5kaXNwYXRjaEV2ZW50KGNoYW5nZUV2ZW50KTtcbiAgfVxuXG4gIGNsZWFyU2VsZWN0ZWRQcm9maWxlKCkge1xuICAgIHRoaXMuc2VsZWN0ZWRQcm9maWxlID0gbnVsbDtcbiAgICB0aGlzLmhhbmRlZG5lc3MgPSBudWxsO1xuICAgIHRoaXMuaGFuZGVkbmVzc1N0b3JhZ2VLZXkgPSBudWxsO1xuICAgIHRoaXMuZWxlbWVudC5kaXNhYmxlZCA9IHRydWU7XG4gICAgdGhpcy5lbGVtZW50LmlubmVySFRNTCA9ICc8b3B0aW9uIHZhbHVlPVwibG9hZGluZ1wiPkxvYWRpbmcuLi48L29wdGlvbj4nO1xuICAgIHRoaXMuZmlyZUhhbmRlZG5lc3NDaGFuZ2UoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25kcyB0byBjaGFuZ2VzIGluIHRoZSBkcm9wZG93biwgc2F2ZXMgdGhlIHZhbHVlIHRvIGxvY2FsIHN0b3JhZ2UsIGFuZCB0cmlnZ2VycyB0aGUgZXZlbnRcbiAgICovXG4gIG9uSGFuZGVkbmVzc1NlbGVjdGVkKCkge1xuICAgIC8vIENyZWF0ZSBhIG1vY2sgZ2FtZXBhZCB0aGF0IG1hdGNoZXMgdGhlIHByb2ZpbGUgYW5kIGhhbmRlZG5lc3NcbiAgICB0aGlzLmhhbmRlZG5lc3MgPSB0aGlzLmVsZW1lbnQudmFsdWU7XG4gICAgd2luZG93LmxvY2FsU3RvcmFnZS5zZXRJdGVtKHRoaXMuaGFuZGVkbmVzc1N0b3JhZ2VLZXksIHRoaXMuaGFuZGVkbmVzcyk7XG4gICAgdGhpcy5maXJlSGFuZGVkbmVzc0NoYW5nZSgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldHMgdGhlIHByb2ZpbGUgZnJvbSB3aGljaCBoYW5kZWRuZXNzIG5lZWRzIHRvIGJlIHNlbGVjdGVkXG4gICAqIEBwYXJhbSB7b2JqZWN0fSBwcm9maWxlXG4gICAqL1xuICBzZXRTZWxlY3RlZFByb2ZpbGUocHJvZmlsZSkge1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgICB0aGlzLnNlbGVjdGVkUHJvZmlsZSA9IHByb2ZpbGU7XG5cbiAgICAvLyBMb2FkIGFuZCBjbGVhciB0aGUgbGFzdCBzZWxlY3Rpb24gZm9yIHRoaXMgcHJvZmlsZSBpZFxuICAgIHRoaXMuaGFuZGVkbmVzc1N0b3JhZ2VLZXkgPSBgJHt0aGlzLnNlbGVjdG9yVHlwZX1fJHt0aGlzLnNlbGVjdGVkUHJvZmlsZS5pZH1faGFuZGVkbmVzc2A7XG4gICAgY29uc3Qgc3RvcmVkSGFuZGVkbmVzcyA9IHdpbmRvdy5sb2NhbFN0b3JhZ2UuZ2V0SXRlbSh0aGlzLmhhbmRlZG5lc3NTdG9yYWdlS2V5KTtcbiAgICB3aW5kb3cubG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0odGhpcy5oYW5kZWRuZXNzU3RvcmFnZUtleSk7XG5cbiAgICAvLyBQb3B1bGF0ZSBoYW5kZWRuZXNzIHNlbGVjdG9yXG4gICAgdGhpcy5lbGVtZW50LmlubmVySFRNTCA9ICcnO1xuICAgIE9iamVjdC5rZXlzKHRoaXMuc2VsZWN0ZWRQcm9maWxlLmxheW91dHMpLmZvckVhY2goKGhhbmRlZG5lc3MpID0+IHtcbiAgICAgIHRoaXMuZWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICAgICAgICA8b3B0aW9uIHZhbHVlPScke2hhbmRlZG5lc3N9Jz4ke2hhbmRlZG5lc3N9PC9vcHRpb24+XG4gICAgICBgO1xuICAgIH0pO1xuXG4gICAgaWYgKHRoaXMuZWxlbWVudC5jaGlsZHJlbi5sZW5ndGggPT09IDApIHtcbiAgICAgIEVycm9yTG9nZ2luZy5sb2coYE5vIGhhbmRlZG5lc3MgdmFsdWVzIGZvdW5kIGZvciBwcm9maWxlICR7dGhpcy5zZWxlY3RlZFByb2ZpbGUuaWR9YCk7XG4gICAgfVxuXG4gICAgLy8gQXBwbHkgc3RvcmVkIGhhbmRlZG5lc3MgaWYgZm91bmRcbiAgICBpZiAoc3RvcmVkSGFuZGVkbmVzcyAmJiB0aGlzLnNlbGVjdGVkUHJvZmlsZS5sYXlvdXRzW3N0b3JlZEhhbmRlZG5lc3NdKSB7XG4gICAgICB0aGlzLmVsZW1lbnQudmFsdWUgPSBzdG9yZWRIYW5kZWRuZXNzO1xuICAgIH1cblxuICAgIC8vIE1hbnVhbGx5IHRyaWdnZXIgdGhlIGhhbmRlZG5lc3MgdG8gY2hhbmdlXG4gICAgdGhpcy5lbGVtZW50LmRpc2FibGVkID0gZmFsc2U7XG4gICAgdGhpcy5vbkhhbmRlZG5lc3NTZWxlY3RlZCgpO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IEhhbmRlZG5lc3NTZWxlY3RvcjtcbiIsIi8qIGVzbGludC1kaXNhYmxlIGltcG9ydC9uby11bnJlc29sdmVkICovXG5pbXBvcnQgeyBmZXRjaFByb2ZpbGUsIGZldGNoUHJvZmlsZXNMaXN0LCBNb3Rpb25Db250cm9sbGVyIH0gZnJvbSAnLi9tb3Rpb24tY29udHJvbGxlcnMubW9kdWxlLmpzJztcbi8qIGVzbGludC1lbmFibGUgKi9cblxuaW1wb3J0IE1vY2tHYW1lcGFkIGZyb20gJy4vbW9ja3MvbW9ja0dhbWVwYWQuanMnO1xuaW1wb3J0IE1vY2tYUklucHV0U291cmNlIGZyb20gJy4vbW9ja3MvbW9ja1hSSW5wdXRTb3VyY2UuanMnO1xuXG5pbXBvcnQgRXJyb3JMb2dnaW5nIGZyb20gJy4vZXJyb3JMb2dnaW5nLmpzJztcbmltcG9ydCBIYW5kZWRuZXNzU2VsZWN0b3IgZnJvbSAnLi9oYW5kZWRuZXNzU2VsZWN0b3IuanMnO1xuXG5jb25zdCBwcm9maWxlSWRTdG9yYWdlS2V5ID0gJ3JlcG9zaXRvcnlfcHJvZmlsZUlkJztcbmNvbnN0IHByb2ZpbGVzQmFzZVBhdGggPSAnLi9wcm9maWxlcyc7XG4vKipcbiAqIExvYWRzIHByb2ZpbGVzIGZyb20gdGhlIGRpc3RyaWJ1dGlvbiBmb2xkZXIgbmV4dCB0byB0aGUgdmlld2VyJ3MgbG9jYXRpb25cbiAqL1xuY2xhc3MgUmVwb3NpdG9yeVNlbGVjdG9yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgdGhpcy5lbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlcG9zaXRvcnknKTtcblxuICAgIC8vIEdldCB0aGUgcHJvZmlsZSBpZCBkcm9wZG93biBhbmQgbGlzdGVuIGZvciBjaGFuZ2VzXG4gICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVwb3NpdG9yeVByb2ZpbGVJZFNlbGVjdG9yJyk7XG4gICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4geyB0aGlzLm9uUHJvZmlsZUlkU2VsZWN0ZWQoKTsgfSk7XG5cbiAgICAvLyBBZGQgYSBoYW5kZWRuZXNzIHNlbGVjdG9yIGFuZCBsaXN0ZW4gZm9yIGNoYW5nZXNcbiAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvciA9IG5ldyBIYW5kZWRuZXNzU2VsZWN0b3IoJ3JlcG9zaXRvcnknKTtcbiAgICB0aGlzLmVsZW1lbnQuYXBwZW5kQ2hpbGQodGhpcy5oYW5kZWRuZXNzU2VsZWN0b3IuZWxlbWVudCk7XG4gICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3IuZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdoYW5kZWRuZXNzQ2hhbmdlJywgKGV2ZW50KSA9PiB7IHRoaXMub25IYW5kZWRuZXNzQ2hhbmdlKGV2ZW50KTsgfSk7XG5cbiAgICB0aGlzLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB0aGlzLmNsZWFyU2VsZWN0ZWRQcm9maWxlKCk7XG4gIH1cblxuICBlbmFibGUoKSB7XG4gICAgdGhpcy5lbGVtZW50LmhpZGRlbiA9IGZhbHNlO1xuICAgIHRoaXMuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB0aGlzLnBvcHVsYXRlUHJvZmlsZVNlbGVjdG9yKCk7XG4gIH1cblxuICBkaXNhYmxlKCkge1xuICAgIHRoaXMuZWxlbWVudC5oaWRkZW4gPSB0cnVlO1xuICAgIHRoaXMuZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgfVxuXG4gIGNsZWFyU2VsZWN0ZWRQcm9maWxlKCkge1xuICAgIEVycm9yTG9nZ2luZy5jbGVhckFsbCgpO1xuICAgIHRoaXMuc2VsZWN0ZWRQcm9maWxlID0gbnVsbDtcbiAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5kaXNhYmxlZCA9IHRydWU7XG4gICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3IuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25kcyB0byBjaGFuZ2VzIGluIHNlbGVjdGVkIGhhbmRlZG5lc3MuXG4gICAqIENyZWF0ZXMgYSBuZXcgbW90aW9uIGNvbnRyb2xsZXIgZm9yIHRoZSBjb21iaW5hdGlvbiBvZiBwcm9maWxlIGFuZCBoYW5kZWRuZXNzLCBhbmQgZmlyZXMgYW5cbiAgICogZXZlbnQgdG8gc2lnbmFsIHRoZSBjaGFuZ2VcbiAgICogQHBhcmFtIHtvYmplY3R9IGV2ZW50XG4gICAqL1xuICBvbkhhbmRlZG5lc3NDaGFuZ2UoZXZlbnQpIHtcbiAgICBpZiAoIXRoaXMuZGlzYWJsZWQpIHtcbiAgICAgIGxldCBtb3Rpb25Db250cm9sbGVyO1xuICAgICAgY29uc3QgaGFuZGVkbmVzcyA9IGV2ZW50LmRldGFpbDtcblxuICAgICAgLy8gQ3JlYXRlIG1vdGlvbiBjb250cm9sbGVyIGlmIGEgaGFuZGVkbmVzcyBoYXMgYmVlbiBzZWxlY3RlZFxuICAgICAgaWYgKGhhbmRlZG5lc3MpIHtcbiAgICAgICAgY29uc3QgbW9ja0dhbWVwYWQgPSBuZXcgTW9ja0dhbWVwYWQodGhpcy5zZWxlY3RlZFByb2ZpbGUsIGhhbmRlZG5lc3MpO1xuICAgICAgICBjb25zdCBtb2NrWFJJbnB1dFNvdXJjZSA9IG5ldyBNb2NrWFJJbnB1dFNvdXJjZShtb2NrR2FtZXBhZCwgaGFuZGVkbmVzcyk7XG5cbiAgICAgICAgZmV0Y2hQcm9maWxlKG1vY2tYUklucHV0U291cmNlLCBwcm9maWxlc0Jhc2VQYXRoKS50aGVuKCh7IHByb2ZpbGUsIGFzc2V0UGF0aCB9KSA9PiB7XG4gICAgICAgICAgbW90aW9uQ29udHJvbGxlciA9IG5ldyBNb3Rpb25Db250cm9sbGVyKFxuICAgICAgICAgICAgbW9ja1hSSW5wdXRTb3VyY2UsXG4gICAgICAgICAgICBwcm9maWxlLFxuICAgICAgICAgICAgYXNzZXRQYXRoXG4gICAgICAgICAgKTtcblxuICAgICAgICAgIC8vIFNpZ25hbCB0aGUgY2hhbmdlXG4gICAgICAgICAgY29uc3QgY2hhbmdlRXZlbnQgPSBuZXcgQ3VzdG9tRXZlbnQoXG4gICAgICAgICAgICAnbW90aW9uQ29udHJvbGxlckNoYW5nZScsXG4gICAgICAgICAgICB7IGRldGFpbDogbW90aW9uQ29udHJvbGxlciB9XG4gICAgICAgICAgKTtcbiAgICAgICAgICB0aGlzLmVsZW1lbnQuZGlzcGF0Y2hFdmVudChjaGFuZ2VFdmVudCk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gU2lnbmFsIHRoZSBjaGFuZ2VcbiAgICAgICAgY29uc3QgY2hhbmdlRXZlbnQgPSBuZXcgQ3VzdG9tRXZlbnQoJ21vdGlvbkNvbnRyb2xsZXJDaGFuZ2UnLCB7IGRldGFpbDogbnVsbCB9KTtcbiAgICAgICAgdGhpcy5lbGVtZW50LmRpc3BhdGNoRXZlbnQoY2hhbmdlRXZlbnQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBIYW5kbGVyIGZvciB0aGUgcHJvZmlsZSBpZCBzZWxlY3Rpb24gY2hhbmdlXG4gICAqL1xuICBvblByb2ZpbGVJZFNlbGVjdGVkKCkge1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcblxuICAgIGNvbnN0IHByb2ZpbGVJZCA9IHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LnZhbHVlO1xuICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbShwcm9maWxlSWRTdG9yYWdlS2V5LCBwcm9maWxlSWQpO1xuXG4gICAgLy8gQXR0ZW1wdCB0byBsb2FkIHRoZSBwcm9maWxlXG4gICAgZmV0Y2hQcm9maWxlKHsgcHJvZmlsZXM6IFtwcm9maWxlSWRdIH0sIHByb2ZpbGVzQmFzZVBhdGgsIGZhbHNlKS50aGVuKCh7IHByb2ZpbGUgfSkgPT4ge1xuICAgICAgdGhpcy5zZWxlY3RlZFByb2ZpbGUgPSBwcm9maWxlO1xuICAgICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3Iuc2V0U2VsZWN0ZWRQcm9maWxlKHRoaXMuc2VsZWN0ZWRQcm9maWxlKTtcbiAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBFcnJvckxvZ2dpbmcubG9nKGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXRyaWV2ZXMgdGhlIGZ1bGwgbGlzdCBvZiBhdmFpbGFibGUgcHJvZmlsZXNcbiAgICovXG4gIHBvcHVsYXRlUHJvZmlsZVNlbGVjdG9yKCkge1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcblxuICAgIC8vIExvYWQgYW5kIGNsZWFyIGxvY2FsIHN0b3JhZ2VcbiAgICBjb25zdCBzdG9yZWRQcm9maWxlSWQgPSB3aW5kb3cubG9jYWxTdG9yYWdlLmdldEl0ZW0ocHJvZmlsZUlkU3RvcmFnZUtleSk7XG4gICAgd2luZG93LmxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKHByb2ZpbGVJZFN0b3JhZ2VLZXkpO1xuXG4gICAgLy8gTG9hZCB0aGUgbGlzdCBvZiBwcm9maWxlc1xuICAgIHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LmlubmVySFRNTCA9ICc8b3B0aW9uIHZhbHVlPVwibG9hZGluZ1wiPkxvYWRpbmcuLi48L29wdGlvbj4nO1xuICAgIGZldGNoUHJvZmlsZXNMaXN0KHByb2ZpbGVzQmFzZVBhdGgpLnRoZW4oKHByb2ZpbGVzTGlzdCkgPT4ge1xuICAgICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuaW5uZXJIVE1MID0gJyc7XG4gICAgICBPYmplY3Qua2V5cyhwcm9maWxlc0xpc3QpLmZvckVhY2goKHByb2ZpbGVJZCkgPT4ge1xuICAgICAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICAgICAgICA8b3B0aW9uIHZhbHVlPScke3Byb2ZpbGVJZH0nPiR7cHJvZmlsZUlkfTwvb3B0aW9uPlxuICAgICAgICBgO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIE92ZXJyaWRlIHRoZSBkZWZhdWx0IHNlbGVjdGlvbiBpZiB2YWx1ZXMgd2VyZSBwcmVzZW50IGluIGxvY2FsIHN0b3JhZ2VcbiAgICAgIGlmIChzdG9yZWRQcm9maWxlSWQpIHtcbiAgICAgICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQudmFsdWUgPSBzdG9yZWRQcm9maWxlSWQ7XG4gICAgICB9XG5cbiAgICAgIC8vIE1hbnVhbGx5IHRyaWdnZXIgc2VsZWN0ZWQgcHJvZmlsZSB0byBsb2FkXG4gICAgICB0aGlzLm9uUHJvZmlsZUlkU2VsZWN0ZWQoKTtcbiAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBFcnJvckxvZ2dpbmcubG9nKGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IFJlcG9zaXRvcnlTZWxlY3RvcjtcbiIsIi8qIGVzbGludC1kaXNhYmxlIGltcG9ydC9uby11bnJlc29sdmVkICovXG5pbXBvcnQgeyBNb3Rpb25Db250cm9sbGVyIH0gZnJvbSAnLi9tb3Rpb24tY29udHJvbGxlcnMubW9kdWxlLmpzJztcbmltcG9ydCAnLi9hanYvYWp2Lm1pbi5qcyc7XG5pbXBvcnQgbWVyZ2VQcm9maWxlIGZyb20gJy4vYXNzZXRUb29scy9tZXJnZVByb2ZpbGUuanMnO1xuaW1wb3J0IHZhbGlkYXRlUmVnaXN0cnlQcm9maWxlIGZyb20gJy4vcmVnaXN0cnlUb29scy92YWxpZGF0ZVJlZ2lzdHJ5UHJvZmlsZS5qcyc7XG4vKiBlc2xpbnQtZW5hYmxlICovXG5cbmltcG9ydCBNb2NrR2FtZXBhZCBmcm9tICcuL21vY2tzL21vY2tHYW1lcGFkLmpzJztcbmltcG9ydCBNb2NrWFJJbnB1dFNvdXJjZSBmcm9tICcuL21vY2tzL21vY2tYUklucHV0U291cmNlLmpzJztcbmltcG9ydCBFcnJvckxvZ2dpbmcgZnJvbSAnLi9lcnJvckxvZ2dpbmcuanMnO1xuaW1wb3J0IEhhbmRlZG5lc3NTZWxlY3RvciBmcm9tICcuL2hhbmRlZG5lc3NTZWxlY3Rvci5qcyc7XG5cbi8qKlxuICogTG9hZHMgc2VsZWN0ZWQgZmlsZSBmcm9tIGZpbGVzeXN0ZW0gYW5kIHNldHMgaXQgYXMgdGhlIHNlbGVjdGVkIHByb2ZpbGVcbiAqIEBwYXJhbSB7T2JqZWN0fSBqc29uRmlsZVxuICovXG5mdW5jdGlvbiBsb2FkTG9jYWxKc29uKGpzb25GaWxlKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTtcblxuICAgIHJlYWRlci5vbmxvYWQgPSAoKSA9PiB7XG4gICAgICBjb25zdCBqc29uID0gSlNPTi5wYXJzZShyZWFkZXIucmVzdWx0KTtcbiAgICAgIHJlc29sdmUoanNvbik7XG4gICAgfTtcblxuICAgIHJlYWRlci5vbmVycm9yID0gKCkgPT4ge1xuICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYFVuYWJsZSB0byBsb2FkIEpTT04gZnJvbSAke2pzb25GaWxlLm5hbWV9YDtcbiAgICAgIEVycm9yTG9nZ2luZy5sb2coZXJyb3JNZXNzYWdlKTtcbiAgICAgIHJlamVjdChlcnJvck1lc3NhZ2UpO1xuICAgIH07XG5cbiAgICByZWFkZXIucmVhZEFzVGV4dChqc29uRmlsZSk7XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBidWlsZFNjaGVtYVZhbGlkYXRvcihzY2hlbWFzUGF0aCkge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKHNjaGVtYXNQYXRoKTtcbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIEVycm9yTG9nZ2luZy50aHJvdyhyZXNwb25zZS5zdGF0dXNUZXh0KTtcbiAgfVxuXG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby11bmRlZlxuICBjb25zdCBhanYgPSBuZXcgQWp2KCk7XG4gIGNvbnN0IHNjaGVtYXMgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIHNjaGVtYXMuZGVwZW5kZW5jaWVzLmZvckVhY2goKHNjaGVtYSkgPT4ge1xuICAgIGFqdi5hZGRTY2hlbWEoc2NoZW1hKTtcbiAgfSk7XG5cbiAgcmV0dXJuIGFqdi5jb21waWxlKHNjaGVtYXMubWFpblNjaGVtYSk7XG59XG5cbi8qKlxuICogTG9hZHMgYSBwcm9maWxlIGZyb20gYSBzZXQgb2YgbG9jYWwgZmlsZXNcbiAqL1xuY2xhc3MgTG9jYWxQcm9maWxlU2VsZWN0b3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICB0aGlzLmVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9jYWxQcm9maWxlJyk7XG4gICAgdGhpcy5sb2NhbEZpbGVzTGlzdEVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9jYWxGaWxlc0xpc3QnKTtcblxuICAgIC8vIEdldCB0aGUgYXNzZXRzIHNlbGVjdG9yIGFuZCB3YXRjaCBmb3IgY2hhbmdlc1xuICAgIHRoaXMucmVnaXN0cnlKc29uU2VsZWN0b3IgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9jYWxQcm9maWxlUmVnaXN0cnlKc29uU2VsZWN0b3InKTtcbiAgICB0aGlzLnJlZ2lzdHJ5SnNvblNlbGVjdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHsgdGhpcy5vblJlZ2lzdHJ5SnNvblNlbGVjdGVkKCk7IH0pO1xuXG4gICAgLy8gR2V0IHRoZSBhc3NldCBqc29uICBzZWxlY3RvciBhbmQgd2F0Y2ggZm9yIGNoYW5nZXNcbiAgICB0aGlzLmFzc2V0SnNvblNlbGVjdG9yID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY2FsUHJvZmlsZUFzc2V0SnNvblNlbGVjdG9yJyk7XG4gICAgdGhpcy5hc3NldEpzb25TZWxlY3Rvci5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7IHRoaXMub25Bc3NldEpzb25TZWxlY3RlZCgpOyB9KTtcblxuICAgIC8vIEdldCB0aGUgcmVnaXN0cnkganNvbiBzZWxlY3RvciBhbmQgd2F0Y2ggZm9yIGNoYW5nZXNcbiAgICB0aGlzLmFzc2V0c1NlbGVjdG9yID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY2FsUHJvZmlsZUFzc2V0c1NlbGVjdG9yJyk7XG4gICAgdGhpcy5hc3NldHNTZWxlY3Rvci5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7IHRoaXMub25Bc3NldHNTZWxlY3RlZCgpOyB9KTtcblxuICAgIC8vIEFkZCBhIGhhbmRlZG5lc3Mgc2VsZWN0b3IgYW5kIGxpc3RlbiBmb3IgY2hhbmdlc1xuICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yID0gbmV3IEhhbmRlZG5lc3NTZWxlY3RvcignbG9jYWxQcm9maWxlJyk7XG4gICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3IuZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdoYW5kZWRuZXNzQ2hhbmdlJywgKGV2ZW50KSA9PiB7IHRoaXMub25IYW5kZWRuZXNzQ2hhbmdlKGV2ZW50KTsgfSk7XG4gICAgdGhpcy5lbGVtZW50Lmluc2VydEJlZm9yZSh0aGlzLmhhbmRlZG5lc3NTZWxlY3Rvci5lbGVtZW50LCB0aGlzLmxvY2FsRmlsZXNMaXN0RWxlbWVudCk7XG5cbiAgICB0aGlzLmRpc2FibGVkID0gdHJ1ZTtcblxuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcblxuICAgIGJ1aWxkU2NoZW1hVmFsaWRhdG9yKCdyZWdpc3RyeVRvb2xzL3JlZ2lzdHJ5U2NoZW1hcy5qc29uJykudGhlbigocmVnaXN0cnlTY2hlbWFWYWxpZGF0b3IpID0+IHtcbiAgICAgIHRoaXMucmVnaXN0cnlTY2hlbWFWYWxpZGF0b3IgPSByZWdpc3RyeVNjaGVtYVZhbGlkYXRvcjtcbiAgICAgIGJ1aWxkU2NoZW1hVmFsaWRhdG9yKCdhc3NldFRvb2xzL2Fzc2V0U2NoZW1hcy5qc29uJykudGhlbigoYXNzZXRTY2hlbWFWYWxpZGF0b3IpID0+IHtcbiAgICAgICAgdGhpcy5hc3NldFNjaGVtYVZhbGlkYXRvciA9IGFzc2V0U2NoZW1hVmFsaWRhdG9yO1xuICAgICAgICAvLyBUT0RPIGZpZ3VyZSBvdXQgZGlzYWJsZWQgdGhpbmdcbiAgICAgICAgdGhpcy5vblJlZ2lzdHJ5SnNvblNlbGVjdGVkKCk7XG4gICAgICAgIHRoaXMub25Bc3NldEpzb25TZWxlY3RlZCgpO1xuICAgICAgICB0aGlzLm9uQXNzZXRzU2VsZWN0ZWQoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgZW5hYmxlKCkge1xuICAgIHRoaXMuZWxlbWVudC5oaWRkZW4gPSBmYWxzZTtcbiAgICB0aGlzLmRpc2FibGVkID0gZmFsc2U7XG4gIH1cblxuICBkaXNhYmxlKCkge1xuICAgIHRoaXMuZWxlbWVudC5oaWRkZW4gPSB0cnVlO1xuICAgIHRoaXMuZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgfVxuXG4gIGNsZWFyU2VsZWN0ZWRQcm9maWxlKCkge1xuICAgIEVycm9yTG9nZ2luZy5jbGVhckFsbCgpO1xuICAgIHRoaXMucmVnaXN0cnlKc29uID0gbnVsbDtcbiAgICB0aGlzLmFzc2V0SnNvbiA9IG51bGw7XG4gICAgdGhpcy5tZXJnZWRQcm9maWxlID0gbnVsbDtcbiAgICB0aGlzLmFzc2V0cyA9IFtdO1xuICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yLmNsZWFyU2VsZWN0ZWRQcm9maWxlKCk7XG4gIH1cblxuICBjcmVhdGVNb3Rpb25Db250cm9sbGVyKCkge1xuICAgIGxldCBtb3Rpb25Db250cm9sbGVyO1xuICAgIGlmICh0aGlzLmhhbmRlZG5lc3NTZWxlY3Rvci5oYW5kZWRuZXNzICYmIHRoaXMubWVyZ2VkUHJvZmlsZSkge1xuICAgICAgY29uc3QgeyBoYW5kZWRuZXNzIH0gPSB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvcjtcbiAgICAgIGNvbnN0IG1vY2tHYW1lcGFkID0gbmV3IE1vY2tHYW1lcGFkKHRoaXMubWVyZ2VkUHJvZmlsZSwgaGFuZGVkbmVzcyk7XG4gICAgICBjb25zdCBtb2NrWFJJbnB1dFNvdXJjZSA9IG5ldyBNb2NrWFJJbnB1dFNvdXJjZShtb2NrR2FtZXBhZCwgaGFuZGVkbmVzcyk7XG5cbiAgICAgIGNvbnN0IGFzc2V0TmFtZSA9IHRoaXMubWVyZ2VkUHJvZmlsZS5sYXlvdXRzW2hhbmRlZG5lc3NdLnBhdGg7XG4gICAgICBjb25zdCBhc3NldFVybCA9IHRoaXMuYXNzZXRzW2Fzc2V0TmFtZV07XG4gICAgICBtb3Rpb25Db250cm9sbGVyID0gbmV3IE1vdGlvbkNvbnRyb2xsZXIobW9ja1hSSW5wdXRTb3VyY2UsIHRoaXMubWVyZ2VkUHJvZmlsZSwgYXNzZXRVcmwpO1xuICAgIH1cblxuICAgIGNvbnN0IGNoYW5nZUV2ZW50ID0gbmV3IEN1c3RvbUV2ZW50KCdtb3Rpb25Db250cm9sbGVyQ2hhbmdlJywgeyBkZXRhaWw6IG1vdGlvbkNvbnRyb2xsZXIgfSk7XG4gICAgdGhpcy5lbGVtZW50LmRpc3BhdGNoRXZlbnQoY2hhbmdlRXZlbnQpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbmRzIHRvIGNoYW5nZXMgaW4gc2VsZWN0ZWQgaGFuZGVkbmVzcy5cbiAgICogQ3JlYXRlcyBhIG5ldyBtb3Rpb24gY29udHJvbGxlciBmb3IgdGhlIGNvbWJpbmF0aW9uIG9mIHByb2ZpbGUgYW5kIGhhbmRlZG5lc3MsIGFuZCBmaXJlcyBhblxuICAgKiBldmVudCB0byBzaWduYWwgdGhlIGNoYW5nZVxuICAgKiBAcGFyYW0ge29iamVjdH0gZXZlbnRcbiAgICovXG4gIG9uSGFuZGVkbmVzc0NoYW5nZSgpIHtcbiAgICBpZiAoIXRoaXMuZGlzYWJsZWQpIHtcbiAgICAgIHRoaXMuY3JlYXRlTW90aW9uQ29udHJvbGxlcigpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG1lcmdlSnNvblByb2ZpbGVzKCkge1xuICAgIGlmICh0aGlzLnJlZ2lzdHJ5SnNvbiAmJiB0aGlzLmFzc2V0SnNvbikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGhpcy5tZXJnZWRQcm9maWxlID0gbWVyZ2VQcm9maWxlKHRoaXMucmVnaXN0cnlKc29uLCB0aGlzLmFzc2V0SnNvbik7XG4gICAgICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yLnNldFNlbGVjdGVkUHJvZmlsZSh0aGlzLm1lcmdlZFByb2ZpbGUpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgRXJyb3JMb2dnaW5nLmxvZyhlcnJvcik7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uUmVnaXN0cnlKc29uU2VsZWN0ZWQoKSB7XG4gICAgaWYgKCF0aGlzLmVsZW1lbnQuZGlzYWJsZWQpIHtcbiAgICAgIHRoaXMucmVnaXN0cnlKc29uID0gbnVsbDtcbiAgICAgIHRoaXMubWVyZ2VkUHJvZmlsZSA9IG51bGw7XG4gICAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3Rvci5jbGVhclNlbGVjdGVkUHJvZmlsZSgpO1xuICAgICAgaWYgKHRoaXMucmVnaXN0cnlKc29uU2VsZWN0b3IuZmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBsb2FkTG9jYWxKc29uKHRoaXMucmVnaXN0cnlKc29uU2VsZWN0b3IuZmlsZXNbMF0pLnRoZW4oKHJlZ2lzdHJ5SnNvbikgPT4ge1xuICAgICAgICAgIGNvbnN0IHZhbGlkID0gdGhpcy5yZWdpc3RyeVNjaGVtYVZhbGlkYXRvcihyZWdpc3RyeUpzb24pO1xuICAgICAgICAgIGlmICghdmFsaWQpIHtcbiAgICAgICAgICAgIEVycm9yTG9nZ2luZy5sb2coSlNPTi5zdHJpbmdpZnkodGhpcy5yZWdpc3RyeVNjaGVtYVZhbGlkYXRvci5lcnJvcnMsIG51bGwsIDIpKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgdmFsaWRhdGVSZWdpc3RyeVByb2ZpbGUocmVnaXN0cnlKc29uKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgIEVycm9yTG9nZ2luZy5sb2coZXJyb3IpO1xuICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMucmVnaXN0cnlKc29uID0gcmVnaXN0cnlKc29uO1xuICAgICAgICAgICAgdGhpcy5tZXJnZUpzb25Qcm9maWxlcygpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25Bc3NldEpzb25TZWxlY3RlZCgpIHtcbiAgICBpZiAoIXRoaXMuZWxlbWVudC5kaXNhYmxlZCkge1xuICAgICAgdGhpcy5hc3NldEpzb24gPSBudWxsO1xuICAgICAgdGhpcy5tZXJnZWRQcm9maWxlID0gbnVsbDtcbiAgICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yLmNsZWFyU2VsZWN0ZWRQcm9maWxlKCk7XG4gICAgICBpZiAodGhpcy5hc3NldEpzb25TZWxlY3Rvci5maWxlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGxvYWRMb2NhbEpzb24odGhpcy5hc3NldEpzb25TZWxlY3Rvci5maWxlc1swXSkudGhlbigoYXNzZXRKc29uKSA9PiB7XG4gICAgICAgICAgY29uc3QgdmFsaWQgPSB0aGlzLmFzc2V0U2NoZW1hVmFsaWRhdG9yKGFzc2V0SnNvbik7XG4gICAgICAgICAgaWYgKCF2YWxpZCkge1xuICAgICAgICAgICAgRXJyb3JMb2dnaW5nLmxvZyhKU09OLnN0cmluZ2lmeSh0aGlzLmFzc2V0U2NoZW1hVmFsaWRhdG9yLmVycm9ycywgbnVsbCwgMikpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmFzc2V0SnNvbiA9IGFzc2V0SnNvbjtcbiAgICAgICAgICAgIHRoaXMubWVyZ2VKc29uUHJvZmlsZXMoKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBIYW5kbGVzIGNoYW5nZXMgdG8gdGhlIHNldCBvZiBsb2NhbCBmaWxlcyBzZWxlY3RlZFxuICAgKi9cbiAgb25Bc3NldHNTZWxlY3RlZCgpIHtcbiAgICBpZiAoIXRoaXMuZWxlbWVudC5kaXNhYmxlZCkge1xuICAgICAgY29uc3QgZmlsZUxpc3QgPSBBcnJheS5mcm9tKHRoaXMuYXNzZXRzU2VsZWN0b3IuZmlsZXMpO1xuICAgICAgdGhpcy5hc3NldHMgPSBbXTtcbiAgICAgIGZpbGVMaXN0LmZvckVhY2goKGZpbGUpID0+IHtcbiAgICAgICAgdGhpcy5hc3NldHNbZmlsZS5uYW1lXSA9IHdpbmRvdy5VUkwuY3JlYXRlT2JqZWN0VVJMKGZpbGUpO1xuICAgICAgfSk7XG4gICAgICB0aGlzLmNyZWF0ZU1vdGlvbkNvbnRyb2xsZXIoKTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgTG9jYWxQcm9maWxlU2VsZWN0b3I7XG4iLCIvKiBlc2xpbnQtZGlzYWJsZSBpbXBvcnQvbm8tdW5yZXNvbHZlZCAqL1xuaW1wb3J0ICogYXMgVEhSRUUgZnJvbSAnLi90aHJlZS9idWlsZC90aHJlZS5tb2R1bGUuanMnO1xuaW1wb3J0IHsgR0xURkxvYWRlciB9IGZyb20gJy4vdGhyZWUvZXhhbXBsZXMvanNtL2xvYWRlcnMvR0xURkxvYWRlci5qcyc7XG5pbXBvcnQgeyBPcmJpdENvbnRyb2xzIH0gZnJvbSAnLi90aHJlZS9leGFtcGxlcy9qc20vY29udHJvbHMvT3JiaXRDb250cm9scy5qcyc7XG5pbXBvcnQgeyBDb25zdGFudHMgfSBmcm9tICcuL21vdGlvbi1jb250cm9sbGVycy5tb2R1bGUuanMnO1xuLyogZXNsaW50LWVuYWJsZSAqL1xuXG5pbXBvcnQgRXJyb3JMb2dnaW5nIGZyb20gJy4vZXJyb3JMb2dnaW5nLmpzJztcblxuY29uc3QgdGhyZWUgPSB7fTtcbmxldCBjYW52YXNQYXJlbnRFbGVtZW50O1xubGV0IGFjdGl2ZU1vZGVsO1xuXG4vKipcbiAqIEBkZXNjcmlwdGlvbiBBdHRhY2hlcyBhIHNtYWxsIGJsdWUgc3BoZXJlIHRvIHRoZSBwb2ludCByZXBvcnRlZCBhcyB0b3VjaGVkIG9uIGFsbCB0b3VjaHBhZHNcbiAqIEBwYXJhbSB7T2JqZWN0fSBtb2RlbCAtIFRoZSBtb2RlbCB0byBhZGQgZG90cyB0b1xuICogQHBhcmFtIHtPYmplY3R9IG1vdGlvbkNvbnRyb2xsZXIgLSBBIE1vdGlvbkNvbnRyb2xsZXIgdG8gYmUgZGlzcGxheWVkIGFuZCBhbmltYXRlZFxuICogQHBhcmFtIHtPYmplY3R9IHJvb3ROb2RlIC0gVGhlIHJvb3Qgbm9kZSBpbiB0aGUgYXNzZXQgdG8gYmUgYW5pbWF0ZWRcbiAqL1xuZnVuY3Rpb24gYWRkVG91Y2hEb3RzKHsgbW90aW9uQ29udHJvbGxlciwgcm9vdE5vZGUgfSkge1xuICBPYmplY3Qua2V5cyhtb3Rpb25Db250cm9sbGVyLmNvbXBvbmVudHMpLmZvckVhY2goKGNvbXBvbmVudElkKSA9PiB7XG4gICAgY29uc3QgY29tcG9uZW50ID0gbW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzW2NvbXBvbmVudElkXTtcbiAgICAvLyBGaW5kIHRoZSB0b3VjaHBhZHNcbiAgICBpZiAoY29tcG9uZW50LnR5cGUgPT09IENvbnN0YW50cy5Db21wb25lbnRUeXBlLlRPVUNIUEFEKSB7XG4gICAgICAvLyBGaW5kIHRoZSBub2RlIHRvIGF0dGFjaCB0aGUgdG91Y2ggZG90LlxuICAgICAgY29uc3QgY29tcG9uZW50Um9vdCA9IHJvb3ROb2RlLmdldE9iamVjdEJ5TmFtZShjb21wb25lbnQucm9vdE5vZGVOYW1lLCB0cnVlKTtcblxuICAgICAgaWYgKCFjb21wb25lbnRSb290KSB7XG4gICAgICAgIEVycm9yTG9nZ2luZy5sb2coYENvdWxkIG5vdCBmaW5kIHJvb3Qgbm9kZSBvZiB0b3VjaHBhZCBjb21wb25lbnQgJHtjb21wb25lbnQucm9vdE5vZGVOYW1lfWApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHRvdWNoUG9pbnRSb290ID0gY29tcG9uZW50Um9vdC5nZXRPYmplY3RCeU5hbWUoY29tcG9uZW50LnRvdWNoUG9pbnROb2RlTmFtZSwgdHJ1ZSk7XG4gICAgICBpZiAoIXRvdWNoUG9pbnRSb290KSB7XG4gICAgICAgIEVycm9yTG9nZ2luZy5sb2coYENvdWxkIG5vdCBmaW5kIHRvdWNoIGRvdCwgJHtjb21wb25lbnQudG91Y2hQb2ludE5vZGVOYW1lfSwgaW4gdG91Y2hwYWQgY29tcG9uZW50ICR7Y29tcG9uZW50SWR9YCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBzcGhlcmVHZW9tZXRyeSA9IG5ldyBUSFJFRS5TcGhlcmVHZW9tZXRyeSgwLjAwMSk7XG4gICAgICAgIGNvbnN0IG1hdGVyaWFsID0gbmV3IFRIUkVFLk1lc2hCYXNpY01hdGVyaWFsKHsgY29sb3I6IDB4MDAwMEZGIH0pO1xuICAgICAgICBjb25zdCBzcGhlcmUgPSBuZXcgVEhSRUUuTWVzaChzcGhlcmVHZW9tZXRyeSwgbWF0ZXJpYWwpO1xuICAgICAgICB0b3VjaFBvaW50Um9vdC5hZGQoc3BoZXJlKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xufVxuXG4vKipcbiAqIEBkZXNjcmlwdGlvbiBXYWxrcyB0aGUgbW9kZWwncyB0cmVlIHRvIGZpbmQgdGhlIG5vZGVzIG5lZWRlZCB0byBhbmltYXRlIHRoZSBjb21wb25lbnRzIGFuZFxuICogc2F2ZXMgdGhlbSBmb3IgdXNlIGluIHRoZSBmcmFtZSBsb29wXG4gKiBAcGFyYW0ge09iamVjdH0gbW9kZWwgLSBUaGUgbW9kZWwgdG8gZmluZCBub2RlcyBpblxuICovXG5mdW5jdGlvbiBmaW5kTm9kZXMobW9kZWwpIHtcbiAgY29uc3Qgbm9kZXMgPSB7fTtcblxuICAvLyBMb29wIHRocm91Z2ggdGhlIGNvbXBvbmVudHMgYW5kIGZpbmQgdGhlIG5vZGVzIG5lZWRlZCBmb3IgZWFjaCBjb21wb25lbnRzJyB2aXN1YWwgcmVzcG9uc2VzXG4gIE9iamVjdC52YWx1ZXMobW9kZWwubW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcbiAgICBjb25zdCBjb21wb25lbnRSb290Tm9kZSA9IG1vZGVsLnJvb3ROb2RlLmdldE9iamVjdEJ5TmFtZShjb21wb25lbnQucm9vdE5vZGVOYW1lLCB0cnVlKTtcbiAgICBjb25zdCBjb21wb25lbnROb2RlcyA9IHt9O1xuXG4gICAgLy8gSWYgdGhlIHJvb3Qgbm9kZSBjYW5ub3QgYmUgZm91bmQsIHNraXAgdGhpcyBjb21wb25lbnRcbiAgICBpZiAoIWNvbXBvbmVudFJvb3ROb2RlKSB7XG4gICAgICBFcnJvckxvZ2dpbmcubG9nKGBDb3VsZCBub3QgZmluZCByb290IG5vZGUgb2YgY29tcG9uZW50ICR7Y29tcG9uZW50LnJvb3ROb2RlTmFtZX1gKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBMb29wIHRocm91Z2ggYWxsIHRoZSB2aXN1YWwgcmVzcG9uc2VzIHRvIGJlIGFwcGxpZWQgdG8gdGhpcyBjb21wb25lbnRcbiAgICBPYmplY3QudmFsdWVzKGNvbXBvbmVudC52aXN1YWxSZXNwb25zZXMpLmZvckVhY2goKHZpc3VhbFJlc3BvbnNlKSA9PiB7XG4gICAgICBjb25zdCB2aXN1YWxSZXNwb25zZU5vZGVzID0ge307XG4gICAgICBjb25zdCB7IHJvb3ROb2RlTmFtZSwgdGFyZ2V0Tm9kZU5hbWUsIHByb3BlcnR5IH0gPSB2aXN1YWxSZXNwb25zZS5kZXNjcmlwdGlvbjtcblxuICAgICAgLy8gRmluZCB0aGUgbm9kZSBhdCB0aGUgdG9wIG9mIHRoZSB2aXN1YWxpemF0aW9uXG4gICAgICBpZiAocm9vdE5vZGVOYW1lID09PSBjb21wb25lbnQucm9vdCkge1xuICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnJvb3ROb2RlID0gY29tcG9uZW50Um9vdE5vZGU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnJvb3ROb2RlID0gY29tcG9uZW50Um9vdE5vZGUuZ2V0T2JqZWN0QnlOYW1lKHJvb3ROb2RlTmFtZSwgdHJ1ZSk7XG4gICAgICB9XG5cbiAgICAgIC8vIElmIHRoZSByb290IG5vZGUgY2Fubm90IGJlIGZvdW5kLCBza2lwIHRoaXMgYW5pbWF0aW9uXG4gICAgICBpZiAoIXZpc3VhbFJlc3BvbnNlTm9kZXMucm9vdE5vZGUpIHtcbiAgICAgICAgRXJyb3JMb2dnaW5nLmxvZyhgQ291bGQgbm90IGZpbmQgcm9vdCBub2RlIG9mIHZpc3VhbCByZXNwb25zZSBmb3IgJHtyb290Tm9kZU5hbWV9YCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gRmluZCB0aGUgbm9kZSB0byBiZSBjaGFuZ2VkXG4gICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnRhcmdldE5vZGUgPSB2aXN1YWxSZXNwb25zZU5vZGVzLnJvb3ROb2RlLmdldE9iamVjdEJ5TmFtZSh0YXJnZXROb2RlTmFtZSk7XG5cbiAgICAgIC8vIElmIGFuaW1hdGluZyBhIHRyYW5zZm9ybSwgZmluZCB0aGUgdHdvIG5vZGVzIHRvIGJlIGludGVycG9sYXRlZCBiZXR3ZWVuLlxuICAgICAgaWYgKHByb3BlcnR5ID09PSAndHJhbnNmb3JtJykge1xuICAgICAgICBjb25zdCB7IG1pbk5vZGVOYW1lLCBtYXhOb2RlTmFtZSB9ID0gdmlzdWFsUmVzcG9uc2UuZGVzY3JpcHRpb247XG4gICAgICAgIHZpc3VhbFJlc3BvbnNlTm9kZXMubWluTm9kZSA9IHZpc3VhbFJlc3BvbnNlTm9kZXMucm9vdE5vZGUuZ2V0T2JqZWN0QnlOYW1lKG1pbk5vZGVOYW1lKTtcbiAgICAgICAgdmlzdWFsUmVzcG9uc2VOb2Rlcy5tYXhOb2RlID0gdmlzdWFsUmVzcG9uc2VOb2Rlcy5yb290Tm9kZS5nZXRPYmplY3RCeU5hbWUobWF4Tm9kZU5hbWUpO1xuXG4gICAgICAgIC8vIElmIHRoZSBleHRlbnRzIGNhbm5vdCBiZSBmb3VuZCwgc2tpcCB0aGlzIGFuaW1hdGlvblxuICAgICAgICBpZiAoIXZpc3VhbFJlc3BvbnNlTm9kZXMubWluTm9kZSB8fCAhdmlzdWFsUmVzcG9uc2VOb2Rlcy5tYXhOb2RlKSB7XG4gICAgICAgICAgRXJyb3JMb2dnaW5nLmxvZyhgQ291bGQgbm90IGZpbmQgZXh0ZW50cyBub2RlcyBvZiB2aXN1YWwgcmVzcG9uc2UgZm9yICR7cm9vdE5vZGVOYW1lfWApO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBBZGQgdGhlIGFuaW1hdGlvbiB0byB0aGUgY29tcG9uZW50J3Mgbm9kZXMgZGljdGlvbmFyeVxuICAgICAgY29tcG9uZW50Tm9kZXNbcm9vdE5vZGVOYW1lXSA9IHZpc3VhbFJlc3BvbnNlTm9kZXM7XG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGhlIGNvbXBvbmVudCdzIGFuaW1hdGlvbnMgdG8gdGhlIGNvbnRyb2xsZXIncyBub2RlcyBkaWN0aW9uYXJ5XG4gICAgbm9kZXNbY29tcG9uZW50LmlkXSA9IGNvbXBvbmVudE5vZGVzO1xuICB9KTtcblxuICByZXR1cm4gbm9kZXM7XG59XG5cblxuZnVuY3Rpb24gY2xlYXIoKSB7XG4gIGlmIChhY3RpdmVNb2RlbCkge1xuICAgIC8vIFJlbW92ZSBhbnkgZXhpc3RpbmcgbW9kZWwgZnJvbSB0aGUgc2NlbmVcbiAgICB0aHJlZS5zY2VuZS5yZW1vdmUoYWN0aXZlTW9kZWwucm9vdE5vZGUpO1xuICAgIGFjdGl2ZU1vZGVsID0gbnVsbDtcbiAgfVxuXG4gIEVycm9yTG9nZ2luZy5jbGVhcigpO1xufVxuLyoqXG4gKiBAZGVzY3JpcHRpb24gRXZlbnQgaGFuZGxlciBmb3Igd2luZG93IHJlc2l6aW5nLlxuICovXG5mdW5jdGlvbiBvblJlc2l6ZSgpIHtcbiAgY29uc3Qgd2lkdGggPSBjYW52YXNQYXJlbnRFbGVtZW50LmNsaWVudFdpZHRoO1xuICBjb25zdCBoZWlnaHQgPSBjYW52YXNQYXJlbnRFbGVtZW50LmNsaWVudEhlaWdodDtcbiAgdGhyZWUuY2FtZXJhLmFzcGVjdFJhdGlvID0gd2lkdGggLyBoZWlnaHQ7XG4gIHRocmVlLmNhbWVyYS51cGRhdGVQcm9qZWN0aW9uTWF0cml4KCk7XG4gIHRocmVlLnJlbmRlcmVyLnNldFNpemUod2lkdGgsIGhlaWdodCk7XG4gIHRocmVlLmNvbnRyb2xzLnVwZGF0ZSgpO1xufVxuXG4vKipcbiAqIEBkZXNjcmlwdGlvbiBDYWxsYmFjayB3aGljaCBydW5zIHRoZSByZW5kZXJpbmcgbG9vcC4gKFBhc3NlZCBpbnRvIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUpXG4gKi9cbmZ1bmN0aW9uIGFuaW1hdGlvbkZyYW1lQ2FsbGJhY2soKSB7XG4gIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUoYW5pbWF0aW9uRnJhbWVDYWxsYmFjayk7XG5cbiAgaWYgKGFjdGl2ZU1vZGVsKSB7XG4gICAgLy8gQ2F1c2UgdGhlIE1vdGlvbkNvbnRyb2xsZXIgdG8gcG9sbCB0aGUgR2FtZXBhZCBmb3IgZGF0YVxuICAgIGFjdGl2ZU1vZGVsLm1vdGlvbkNvbnRyb2xsZXIudXBkYXRlRnJvbUdhbWVwYWQoKTtcblxuICAgIC8vIFVwZGF0ZSB0aGUgM0QgbW9kZWwgdG8gcmVmbGVjdCB0aGUgYnV0dG9uLCB0aHVtYnN0aWNrLCBhbmQgdG91Y2hwYWQgc3RhdGVcbiAgICBPYmplY3QudmFsdWVzKGFjdGl2ZU1vZGVsLm1vdGlvbkNvbnRyb2xsZXIuY29tcG9uZW50cykuZm9yRWFjaCgoY29tcG9uZW50KSA9PiB7XG4gICAgICBjb25zdCBjb21wb25lbnROb2RlcyA9IGFjdGl2ZU1vZGVsLm5vZGVzW2NvbXBvbmVudC5pZF07XG5cbiAgICAgIC8vIFNraXAgaWYgdGhlIGNvbXBvbmVudCBub2RlIGlzIG5vdCBmb3VuZC4gTm8gZXJyb3IgaXMgbmVlZGVkLCBiZWNhdXNlIGl0XG4gICAgICAvLyB3aWxsIGhhdmUgYmVlbiByZXBvcnRlZCBhdCBsb2FkIHRpbWUuXG4gICAgICBpZiAoIWNvbXBvbmVudE5vZGVzKSByZXR1cm47XG5cbiAgICAgIC8vIFVwZGF0ZSBub2RlIGRhdGEgYmFzZWQgb24gdGhlIHZpc3VhbCByZXNwb25zZXMnIGN1cnJlbnQgc3RhdGVzXG4gICAgICBPYmplY3QudmFsdWVzKGNvbXBvbmVudC52aXN1YWxSZXNwb25zZXMpLmZvckVhY2goKHZpc3VhbFJlc3BvbnNlKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgZGVzY3JpcHRpb24sIHZhbHVlIH0gPSB2aXN1YWxSZXNwb25zZTtcbiAgICAgICAgY29uc3QgdmlzdWFsUmVzcG9uc2VOb2RlcyA9IGNvbXBvbmVudE5vZGVzW2Rlc2NyaXB0aW9uLnJvb3ROb2RlTmFtZV07XG5cbiAgICAgICAgLy8gU2tpcCBpZiB0aGUgdmlzdWFsIHJlc3BvbnNlIG5vZGUgaXMgbm90IGZvdW5kLiBObyBlcnJvciBpcyBuZWVkZWQsXG4gICAgICAgIC8vIGJlY2F1c2UgaXQgd2lsbCBoYXZlIGJlZW4gcmVwb3J0ZWQgYXQgbG9hZCB0aW1lLlxuICAgICAgICBpZiAoIXZpc3VhbFJlc3BvbnNlTm9kZXMpIHJldHVybjtcblxuICAgICAgICAvLyBDYWxjdWxhdGUgdGhlIG5ldyBwcm9wZXJ0aWVzIGJhc2VkIG9uIHRoZSB3ZWlnaHQgc3VwcGxpZWRcbiAgICAgICAgaWYgKGRlc2NyaXB0aW9uLnByb3BlcnR5ID09PSAndmlzaWJpbGl0eScpIHtcbiAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnRhcmdldE5vZGUudmlzaWJsZSA9IHZhbHVlO1xuICAgICAgICB9IGVsc2UgaWYgKGRlc2NyaXB0aW9uLnByb3BlcnR5ID09PSAndHJhbnNmb3JtJykge1xuICAgICAgICAgIFRIUkVFLlF1YXRlcm5pb24uc2xlcnAoXG4gICAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLm1pbk5vZGUucXVhdGVybmlvbixcbiAgICAgICAgICAgIHZpc3VhbFJlc3BvbnNlTm9kZXMubWF4Tm9kZS5xdWF0ZXJuaW9uLFxuICAgICAgICAgICAgdmlzdWFsUmVzcG9uc2VOb2Rlcy50YXJnZXROb2RlLnF1YXRlcm5pb24sXG4gICAgICAgICAgICB2YWx1ZVxuICAgICAgICAgICk7XG5cbiAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnRhcmdldE5vZGUucG9zaXRpb24ubGVycFZlY3RvcnMoXG4gICAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLm1pbk5vZGUucG9zaXRpb24sXG4gICAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLm1heE5vZGUucG9zaXRpb24sXG4gICAgICAgICAgICB2YWx1ZVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgdGhyZWUucmVuZGVyZXIucmVuZGVyKHRocmVlLnNjZW5lLCB0aHJlZS5jYW1lcmEpO1xuICB0aHJlZS5jb250cm9scy51cGRhdGUoKTtcbn1cblxuY29uc3QgTW9kZWxWaWV3ZXIgPSB7XG4gIGluaXRpYWxpemU6ICgpID0+IHtcbiAgICBjYW52YXNQYXJlbnRFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21vZGVsVmlld2VyJyk7XG4gICAgY29uc3Qgd2lkdGggPSBjYW52YXNQYXJlbnRFbGVtZW50LmNsaWVudFdpZHRoO1xuICAgIGNvbnN0IGhlaWdodCA9IGNhbnZhc1BhcmVudEVsZW1lbnQuY2xpZW50SGVpZ2h0O1xuXG4gICAgLy8gU2V0IHVwIHRoZSBUSFJFRS5qcyBpbmZyYXN0cnVjdHVyZVxuICAgIHRocmVlLmNhbWVyYSA9IG5ldyBUSFJFRS5QZXJzcGVjdGl2ZUNhbWVyYSg3NSwgd2lkdGggLyBoZWlnaHQsIDAuMDEsIDEwMDApO1xuICAgIHRocmVlLmNhbWVyYS5wb3NpdGlvbi55ID0gMC41O1xuICAgIHRocmVlLnNjZW5lID0gbmV3IFRIUkVFLlNjZW5lKCk7XG4gICAgdGhyZWUuc2NlbmUuYmFja2dyb3VuZCA9IG5ldyBUSFJFRS5Db2xvcigweDAwYWE0NCk7XG4gICAgdGhyZWUucmVuZGVyZXIgPSBuZXcgVEhSRUUuV2ViR0xSZW5kZXJlcih7IGFudGlhbGlhczogdHJ1ZSB9KTtcbiAgICB0aHJlZS5yZW5kZXJlci5zZXRTaXplKHdpZHRoLCBoZWlnaHQpO1xuICAgIHRocmVlLnJlbmRlcmVyLmdhbW1hT3V0cHV0ID0gdHJ1ZTtcbiAgICB0aHJlZS5sb2FkZXIgPSBuZXcgR0xURkxvYWRlcigpO1xuXG4gICAgLy8gU2V0IHVwIHRoZSBjb250cm9scyBmb3IgbW92aW5nIHRoZSBzY2VuZSBhcm91bmRcbiAgICB0aHJlZS5jb250cm9scyA9IG5ldyBPcmJpdENvbnRyb2xzKHRocmVlLmNhbWVyYSwgdGhyZWUucmVuZGVyZXIuZG9tRWxlbWVudCk7XG4gICAgdGhyZWUuY29udHJvbHMuZW5hYmxlRGFtcGluZyA9IHRydWU7XG4gICAgdGhyZWUuY29udHJvbHMubWluRGlzdGFuY2UgPSAwLjA1O1xuICAgIHRocmVlLmNvbnRyb2xzLm1heERpc3RhbmNlID0gMC4zO1xuICAgIHRocmVlLmNvbnRyb2xzLmVuYWJsZVBhbiA9IGZhbHNlO1xuICAgIHRocmVlLmNvbnRyb2xzLnVwZGF0ZSgpO1xuXG4gICAgLy8gU2V0IHVwIHRoZSBsaWdodHMgc28gdGhlIG1vZGVsIGNhbiBiZSBzZWVuXG4gICAgY29uc3QgYm90dG9tRGlyZWN0aW9uYWxMaWdodCA9IG5ldyBUSFJFRS5EaXJlY3Rpb25hbExpZ2h0KDB4RkZGRkZGLCAyKTtcbiAgICBib3R0b21EaXJlY3Rpb25hbExpZ2h0LnBvc2l0aW9uLnNldCgwLCAtMSwgMCk7XG4gICAgdGhyZWUuc2NlbmUuYWRkKGJvdHRvbURpcmVjdGlvbmFsTGlnaHQpO1xuICAgIGNvbnN0IHRvcERpcmVjdGlvbmFsTGlnaHQgPSBuZXcgVEhSRUUuRGlyZWN0aW9uYWxMaWdodCgweEZGRkZGRiwgMik7XG4gICAgdGhyZWUuc2NlbmUuYWRkKHRvcERpcmVjdGlvbmFsTGlnaHQpO1xuXG4gICAgLy8gQWRkIHRoZSBUSFJFRS5qcyBjYW52YXMgdG8gdGhlIHBhZ2VcbiAgICBjYW52YXNQYXJlbnRFbGVtZW50LmFwcGVuZENoaWxkKHRocmVlLnJlbmRlcmVyLmRvbUVsZW1lbnQpO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdyZXNpemUnLCBvblJlc2l6ZSwgZmFsc2UpO1xuXG4gICAgLy8gU3RhcnQgcHVtcGluZyBmcmFtZXNcbiAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKGFuaW1hdGlvbkZyYW1lQ2FsbGJhY2spO1xuICB9LFxuXG4gIGxvYWRNb2RlbDogYXN5bmMgKG1vdGlvbkNvbnRyb2xsZXIpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZ2x0ZkFzc2V0ID0gYXdhaXQgbmV3IFByb21pc2UoKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgdGhyZWUubG9hZGVyLmxvYWQoXG4gICAgICAgICAgbW90aW9uQ29udHJvbGxlci5hc3NldFVybCxcbiAgICAgICAgICAobG9hZGVkQXNzZXQpID0+IHsgcmVzb2x2ZShsb2FkZWRBc3NldCk7IH0sXG4gICAgICAgICAgbnVsbCxcbiAgICAgICAgICAoKSA9PiB7IHJlamVjdChuZXcgRXJyb3IoYEFzc2V0ICR7bW90aW9uQ29udHJvbGxlci5hc3NldFVybH0gbWlzc2luZyBvciBtYWxmb3JtZWQuYCkpOyB9XG4gICAgICAgICk7XG4gICAgICB9KSk7XG5cbiAgICAgIC8vIFJlbW92ZSBhbnkgZXhpc3RpbmcgbW9kZWwgZnJvbSB0aGUgc2NlbmVcbiAgICAgIGNsZWFyKCk7XG5cbiAgICAgIGNvbnN0IG1vZGVsID0ge1xuICAgICAgICBtb3Rpb25Db250cm9sbGVyLFxuICAgICAgICByb290Tm9kZTogZ2x0ZkFzc2V0LnNjZW5lXG4gICAgICB9O1xuXG4gICAgICBtb2RlbC5ub2RlcyA9IGZpbmROb2Rlcyhtb2RlbCk7XG4gICAgICBhZGRUb3VjaERvdHMobW9kZWwpO1xuXG4gICAgICAvLyBTZXQgdGhlIG5ldyBtb2RlbFxuICAgICAgYWN0aXZlTW9kZWwgPSBtb2RlbDtcbiAgICAgIHRocmVlLnNjZW5lLmFkZChhY3RpdmVNb2RlbC5yb290Tm9kZSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIEVycm9yTG9nZ2luZy50aHJvdyhlcnJvcik7XG4gICAgfVxuICB9LFxuXG4gIGNsZWFyXG59O1xuXG5leHBvcnQgZGVmYXVsdCBNb2RlbFZpZXdlcjtcbiIsIi8qIGVzbGludC1kaXNhYmxlIGltcG9ydC9uby11bnJlc29sdmVkICovXG5pbXBvcnQgeyBDb25zdGFudHMgfSBmcm9tICcuL21vdGlvbi1jb250cm9sbGVycy5tb2R1bGUuanMnO1xuLyogZXNsaW50LWVuYWJsZSAqL1xuXG5sZXQgbW90aW9uQ29udHJvbGxlcjtcbmxldCBtb2NrR2FtZXBhZDtcbmxldCBjb250cm9sc0xpc3RFbGVtZW50O1xuXG5mdW5jdGlvbiBhbmltYXRpb25GcmFtZUNhbGxiYWNrKCkge1xuICBpZiAobW90aW9uQ29udHJvbGxlcikge1xuICAgIE9iamVjdC52YWx1ZXMobW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcbiAgICAgIGNvbnN0IGRhdGFFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoYCR7Y29tcG9uZW50LmlkfV9kYXRhYCk7XG4gICAgICBkYXRhRWxlbWVudC5pbm5lckhUTUwgPSBKU09OLnN0cmluZ2lmeShjb21wb25lbnQuZGF0YSwgbnVsbCwgMik7XG4gICAgfSk7XG4gICAgd2luZG93LnJlcXVlc3RBbmltYXRpb25GcmFtZShhbmltYXRpb25GcmFtZUNhbGxiYWNrKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBvbkJ1dHRvblRvdWNoZWQoZXZlbnQpIHtcbiAgY29uc3QgeyBpbmRleCB9ID0gZXZlbnQudGFyZ2V0LmRhdGFzZXQ7XG4gIG1vY2tHYW1lcGFkLmJ1dHRvbnNbaW5kZXhdLnRvdWNoZWQgPSBldmVudC50YXJnZXQuY2hlY2tlZDtcbn1cblxuZnVuY3Rpb24gb25CdXR0b25QcmVzc2VkKGV2ZW50KSB7XG4gIGNvbnN0IHsgaW5kZXggfSA9IGV2ZW50LnRhcmdldC5kYXRhc2V0O1xuICBtb2NrR2FtZXBhZC5idXR0b25zW2luZGV4XS5wcmVzc2VkID0gZXZlbnQudGFyZ2V0LmNoZWNrZWQ7XG59XG5cbmZ1bmN0aW9uIG9uQnV0dG9uVmFsdWVDaGFuZ2UoZXZlbnQpIHtcbiAgY29uc3QgeyBpbmRleCB9ID0gZXZlbnQudGFyZ2V0LmRhdGFzZXQ7XG4gIG1vY2tHYW1lcGFkLmJ1dHRvbnNbaW5kZXhdLnZhbHVlID0gTnVtYmVyKGV2ZW50LnRhcmdldC52YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIG9uQXhpc1ZhbHVlQ2hhbmdlKGV2ZW50KSB7XG4gIGNvbnN0IHsgaW5kZXggfSA9IGV2ZW50LnRhcmdldC5kYXRhc2V0O1xuICBtb2NrR2FtZXBhZC5heGVzW2luZGV4XSA9IE51bWJlcihldmVudC50YXJnZXQudmFsdWUpO1xufVxuXG5mdW5jdGlvbiBjbGVhcigpIHtcbiAgbW90aW9uQ29udHJvbGxlciA9IHVuZGVmaW5lZDtcbiAgbW9ja0dhbWVwYWQgPSB1bmRlZmluZWQ7XG5cbiAgaWYgKCFjb250cm9sc0xpc3RFbGVtZW50KSB7XG4gICAgY29udHJvbHNMaXN0RWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb250cm9sc0xpc3QnKTtcbiAgfVxuICBjb250cm9sc0xpc3RFbGVtZW50LmlubmVySFRNTCA9ICcnO1xufVxuXG5mdW5jdGlvbiBhZGRCdXR0b25Db250cm9scyhjb21wb25lbnRDb250cm9sc0VsZW1lbnQsIGJ1dHRvbkluZGV4KSB7XG4gIGNvbnN0IGJ1dHRvbkNvbnRyb2xzRWxlbWVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICBidXR0b25Db250cm9sc0VsZW1lbnQuc2V0QXR0cmlidXRlKCdjbGFzcycsICdjb21wb25lbnRDb250cm9scycpO1xuXG4gIGJ1dHRvbkNvbnRyb2xzRWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICA8bGFiZWw+YnV0dG9uVmFsdWU8L2xhYmVsPlxuICA8aW5wdXQgaWQ9XCJidXR0b25zWyR7YnV0dG9uSW5kZXh9XS52YWx1ZVwiIGRhdGEtaW5kZXg9XCIke2J1dHRvbkluZGV4fVwiIHR5cGU9XCJyYW5nZVwiIG1pbj1cIjBcIiBtYXg9XCIxXCIgc3RlcD1cIjAuMDFcIiB2YWx1ZT1cIjBcIj5cbiAgXG4gIDxsYWJlbD50b3VjaGVkPC9sYWJlbD5cbiAgPGlucHV0IGlkPVwiYnV0dG9uc1ske2J1dHRvbkluZGV4fV0udG91Y2hlZFwiIGRhdGEtaW5kZXg9XCIke2J1dHRvbkluZGV4fVwiIHR5cGU9XCJjaGVja2JveFwiPlxuXG4gIDxsYWJlbD5wcmVzc2VkPC9sYWJlbD5cbiAgPGlucHV0IGlkPVwiYnV0dG9uc1ske2J1dHRvbkluZGV4fV0ucHJlc3NlZFwiIGRhdGEtaW5kZXg9XCIke2J1dHRvbkluZGV4fVwiIHR5cGU9XCJjaGVja2JveFwiPlxuICBgO1xuXG4gIGNvbXBvbmVudENvbnRyb2xzRWxlbWVudC5hcHBlbmRDaGlsZChidXR0b25Db250cm9sc0VsZW1lbnQpO1xuXG4gIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBidXR0b25zWyR7YnV0dG9uSW5kZXh9XS52YWx1ZWApLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0Jywgb25CdXR0b25WYWx1ZUNoYW5nZSk7XG4gIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBidXR0b25zWyR7YnV0dG9uSW5kZXh9XS50b3VjaGVkYCkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvbkJ1dHRvblRvdWNoZWQpO1xuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgYnV0dG9uc1ske2J1dHRvbkluZGV4fV0ucHJlc3NlZGApLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgb25CdXR0b25QcmVzc2VkKTtcbn1cblxuZnVuY3Rpb24gYWRkQXhpc0NvbnRyb2xzKGNvbXBvbmVudENvbnRyb2xzRWxlbWVudCwgYXhpc05hbWUsIGF4aXNJbmRleCkge1xuICBjb25zdCBheGlzQ29udHJvbHNFbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gIGF4aXNDb250cm9sc0VsZW1lbnQuc2V0QXR0cmlidXRlKCdjbGFzcycsICdjb21wb25lbnRDb250cm9scycpO1xuXG4gIGF4aXNDb250cm9sc0VsZW1lbnQuaW5uZXJIVE1MICs9IGBcbiAgPGxhYmVsPiR7YXhpc05hbWV9PGxhYmVsPlxuICA8aW5wdXQgaWQ9XCJheGVzWyR7YXhpc0luZGV4fV1cIiBkYXRhLWluZGV4PVwiJHtheGlzSW5kZXh9XCJcbiAgICAgICAgICB0eXBlPVwicmFuZ2VcIiBtaW49XCItMVwiIG1heD1cIjFcIiBzdGVwPVwiMC4wMVwiIHZhbHVlPVwiMFwiPlxuICBgO1xuXG4gIGNvbXBvbmVudENvbnRyb2xzRWxlbWVudC5hcHBlbmRDaGlsZChheGlzQ29udHJvbHNFbGVtZW50KTtcblxuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgYXhlc1ske2F4aXNJbmRleH1dYCkuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBvbkF4aXNWYWx1ZUNoYW5nZSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkKHNvdXJjZU1vdGlvbkNvbnRyb2xsZXIpIHtcbiAgY2xlYXIoKTtcblxuICBtb3Rpb25Db250cm9sbGVyID0gc291cmNlTW90aW9uQ29udHJvbGxlcjtcbiAgbW9ja0dhbWVwYWQgPSBtb3Rpb25Db250cm9sbGVyLnhySW5wdXRTb3VyY2UuZ2FtZXBhZDtcblxuICBPYmplY3QudmFsdWVzKG1vdGlvbkNvbnRyb2xsZXIuY29tcG9uZW50cykuZm9yRWFjaCgoY29tcG9uZW50KSA9PiB7XG4gICAgY29uc3Qge1xuICAgICAgW0NvbnN0YW50cy5Db21wb25lbnRQcm9wZXJ0eS5CVVRUT05dOiBidXR0b25JbmRleCxcbiAgICAgIFtDb25zdGFudHMuQ29tcG9uZW50UHJvcGVydHkuWF9BWElTXTogeEF4aXNJbmRleCxcbiAgICAgIFtDb25zdGFudHMuQ29tcG9uZW50UHJvcGVydHkuWV9BWElTXTogeUF4aXNJbmRleFxuICAgIH0gPSBjb21wb25lbnQuZGVzY3JpcHRpb24uZ2FtZXBhZEluZGljZXM7XG5cbiAgICBjb25zdCBjb21wb25lbnRDb250cm9sc0VsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsaScpO1xuICAgIGNvbXBvbmVudENvbnRyb2xzRWxlbWVudC5zZXRBdHRyaWJ1dGUoJ2NsYXNzJywgJ2NvbXBvbmVudCcpO1xuICAgIGNvbnRyb2xzTGlzdEVsZW1lbnQuYXBwZW5kQ2hpbGQoY29tcG9uZW50Q29udHJvbHNFbGVtZW50KTtcblxuICAgIGNvbnN0IGhlYWRpbmdFbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaDQnKTtcbiAgICBoZWFkaW5nRWxlbWVudC5pbm5lclRleHQgPSBgJHtjb21wb25lbnQuaWR9YDtcbiAgICBjb21wb25lbnRDb250cm9sc0VsZW1lbnQuYXBwZW5kQ2hpbGQoaGVhZGluZ0VsZW1lbnQpO1xuXG4gICAgaWYgKGJ1dHRvbkluZGV4ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGFkZEJ1dHRvbkNvbnRyb2xzKGNvbXBvbmVudENvbnRyb2xzRWxlbWVudCwgYnV0dG9uSW5kZXgpO1xuICAgIH1cblxuICAgIGlmICh4QXhpc0luZGV4ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGFkZEF4aXNDb250cm9scyhjb21wb25lbnRDb250cm9sc0VsZW1lbnQsICd4QXhpcycsIHhBeGlzSW5kZXgpO1xuICAgIH1cblxuICAgIGlmICh5QXhpc0luZGV4ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGFkZEF4aXNDb250cm9scyhjb21wb25lbnRDb250cm9sc0VsZW1lbnQsICd5QXhpcycsIHlBeGlzSW5kZXgpO1xuICAgIH1cblxuICAgIGNvbnN0IGRhdGFFbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncHJlJyk7XG4gICAgZGF0YUVsZW1lbnQuaWQgPSBgJHtjb21wb25lbnQuaWR9X2RhdGFgO1xuICAgIGNvbXBvbmVudENvbnRyb2xzRWxlbWVudC5hcHBlbmRDaGlsZChkYXRhRWxlbWVudCk7XG5cbiAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKGFuaW1hdGlvbkZyYW1lQ2FsbGJhY2spO1xuICB9KTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgeyBjbGVhciwgYnVpbGQgfTtcbiIsImltcG9ydCBSZXBvc2l0b3J5U2VsZWN0b3IgZnJvbSAnLi9yZXBvc2l0b3J5U2VsZWN0b3IuanMnO1xuaW1wb3J0IExvY2FsUHJvZmlsZVNlbGVjdG9yIGZyb20gJy4vbG9jYWxQcm9maWxlU2VsZWN0b3IuanMnO1xuaW1wb3J0IE1vZGVsVmlld2VyIGZyb20gJy4vbW9kZWxWaWV3ZXIuanMnO1xuaW1wb3J0IE1hbnVhbENvbnRyb2xzIGZyb20gJy4vbWFudWFsQ29udHJvbHMuanMnO1xuaW1wb3J0IEVycm9yTG9nZ2luZyBmcm9tICcuL2Vycm9yTG9nZ2luZy5qcyc7XG5cbmNvbnN0IHNlbGVjdG9ySWRTdG9yYWdlS2V5ID0gJ3NlbGVjdG9ySWQnO1xuY29uc3Qgc2VsZWN0b3JzID0ge307XG5sZXQgYWN0aXZlU2VsZWN0b3I7XG5cbi8qKlxuICogVXBkYXRlcyB0aGUgY29udHJvbHMgYW5kIG1vZGVsIHZpZXdlciB3aGVuIHRoZSBzZWxlY3RlZCBtb3Rpb24gY29udHJvbGxlciBjaGFuZ2VzXG4gKiBAcGFyYW0ge09iamVjdH0gZXZlbnRcbiAqL1xuZnVuY3Rpb24gb25Nb3Rpb25Db250cm9sbGVyQ2hhbmdlKGV2ZW50KSB7XG4gIGlmIChldmVudC50YXJnZXQgPT09IGFjdGl2ZVNlbGVjdG9yLmVsZW1lbnQpIHtcbiAgICBFcnJvckxvZ2dpbmcuY2xlYXJBbGwoKTtcbiAgICBpZiAoIWV2ZW50LmRldGFpbCkge1xuICAgICAgTW9kZWxWaWV3ZXIuY2xlYXIoKTtcbiAgICAgIE1hbnVhbENvbnRyb2xzLmNsZWFyKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IG1vdGlvbkNvbnRyb2xsZXIgPSBldmVudC5kZXRhaWw7XG4gICAgICBNYW51YWxDb250cm9scy5idWlsZChtb3Rpb25Db250cm9sbGVyKTtcbiAgICAgIE1vZGVsVmlld2VyLmxvYWRNb2RlbChtb3Rpb25Db250cm9sbGVyKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBIYW5kbGVzIHRoZSBzZWxlY3Rpb24gc291cmNlIHJhZGlvIGJ1dHRvbiBjaGFuZ2VcbiAqL1xuZnVuY3Rpb24gb25SYWRpb0NoYW5nZSgpIHtcbiAgTWFudWFsQ29udHJvbHMuY2xlYXIoKTtcbiAgTW9kZWxWaWV3ZXIuY2xlYXIoKTtcblxuICAvLyBGaWd1cmUgb3V0IHdoaWNoIGl0ZW0gaXMgbm93IHNlbGVjdGVkXG4gIGNvbnN0IHNlbGVjdGVkUXVlcnkgPSAnaW5wdXRbbmFtZSA9IFwic291cmNlU2VsZWN0b3JcIl06Y2hlY2tlZCc7XG4gIGNvbnN0IHNlbGVjdG9yVHlwZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsZWN0ZWRRdWVyeSkudmFsdWU7XG5cbiAgLy8gRGlzYWJsZSB0aGUgcHJldmlvdXMgc2VsZWN0aW9uIHNvdXJjZVxuICBpZiAoYWN0aXZlU2VsZWN0b3IpIHtcbiAgICBhY3RpdmVTZWxlY3Rvci5kaXNhYmxlKCk7XG4gIH1cblxuICAvLyBTdGFydCB1c2luZyB0aGUgbmV3IHNlbGVjdGlvbiBzb3VyY2VcbiAgYWN0aXZlU2VsZWN0b3IgPSBzZWxlY3RvcnNbc2VsZWN0b3JUeXBlXTtcbiAgYWN0aXZlU2VsZWN0b3IuZW5hYmxlKCk7XG4gIHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbShzZWxlY3RvcklkU3RvcmFnZUtleSwgc2VsZWN0b3JUeXBlKTtcbn1cblxuZnVuY3Rpb24gb25Mb2FkKCkge1xuICBNb2RlbFZpZXdlci5pbml0aWFsaXplKCk7XG5cbiAgLy8gSG9vayB1cCBldmVudCBsaXN0ZW5lcnMgdG8gdGhlIHJhZGlvIGJ1dHRvbnNcbiAgY29uc3QgcmVwb3NpdG9yeVJhZGlvQnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlcG9zaXRvcnlSYWRpb0J1dHRvbicpO1xuICBjb25zdCBsb2NhbFByb2ZpbGVSYWRpb0J1dHRvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NhbFByb2ZpbGVSYWRpb0J1dHRvbicpO1xuICByZXBvc2l0b3J5UmFkaW9CdXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgb25SYWRpb0NoYW5nZSk7XG4gIGxvY2FsUHJvZmlsZVJhZGlvQnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIG9uUmFkaW9DaGFuZ2UpO1xuXG4gIC8vIENoZWNrIGlmIHRoZSBwYWdlIGhhcyBzdG9yZWQgYSBjaG9pY2Ugb2Ygc2VsZWN0aW9uIHNvdXJjZVxuICBjb25zdCBzdG9yZWRTZWxlY3RvcklkID0gd2luZG93LmxvY2FsU3RvcmFnZS5nZXRJdGVtKHNlbGVjdG9ySWRTdG9yYWdlS2V5KTtcbiAgY29uc3QgcmFkaW9CdXR0b25Ub1NlbGVjdCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoYGlucHV0W3ZhbHVlID0gXCIke3N0b3JlZFNlbGVjdG9ySWR9XCJdYCk7XG4gIGlmIChyYWRpb0J1dHRvblRvU2VsZWN0KSB7XG4gICAgcmFkaW9CdXR0b25Ub1NlbGVjdC5jaGVja2VkID0gdHJ1ZTtcbiAgfVxuXG4gIC8vIENyZWF0ZSB0aGUgb2JqZWN0cyB0byBzZWxlY3QgbW90aW9uIGNvbnRyb2xsZXJzIGJhc2VkIG9uIHVzZXIgaW5wdXRcbiAgc2VsZWN0b3JzLnJlcG9zaXRvcnkgPSBuZXcgUmVwb3NpdG9yeVNlbGVjdG9yKCk7XG4gIHNlbGVjdG9ycy5sb2NhbFByb2ZpbGUgPSBuZXcgTG9jYWxQcm9maWxlU2VsZWN0b3IoKTtcbiAgT2JqZWN0LnZhbHVlcyhzZWxlY3RvcnMpLmZvckVhY2goKHNlbGVjdG9yKSA9PiB7XG4gICAgc2VsZWN0b3IuZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3Rpb25Db250cm9sbGVyQ2hhbmdlJywgb25Nb3Rpb25Db250cm9sbGVyQ2hhbmdlKTtcbiAgfSk7XG5cbiAgLy8gbWFudWFsbHkgdHJpZ2dlciBmaXJzdCBjaGVja1xuICBvblJhZGlvQ2hhbmdlKCk7XG59XG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignbG9hZCcsIG9uTG9hZCk7XG4iXSwibmFtZXMiOlsiQ29uc3RhbnRzIiwiVEhSRUUuU3BoZXJlR2VvbWV0cnkiLCJUSFJFRS5NZXNoQmFzaWNNYXRlcmlhbCIsIlRIUkVFLk1lc2giLCJUSFJFRS5RdWF0ZXJuaW9uIiwiVEhSRUUuUGVyc3BlY3RpdmVDYW1lcmEiLCJUSFJFRS5TY2VuZSIsIlRIUkVFLkNvbG9yIiwiVEhSRUUuV2ViR0xSZW5kZXJlciIsIlRIUkVFLkRpcmVjdGlvbmFsTGlnaHQiLCJhbmltYXRpb25GcmFtZUNhbGxiYWNrIiwiY2xlYXIiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7O0FBQUEsTUFBTSxTQUFTLEdBQUc7RUFDaEIsVUFBVSxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDeEIsSUFBSSxFQUFFLE1BQU07SUFDWixJQUFJLEVBQUUsTUFBTTtJQUNaLEtBQUssRUFBRSxPQUFPO0dBQ2YsQ0FBQzs7RUFFRixjQUFjLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUM1QixPQUFPLEVBQUUsU0FBUztJQUNsQixPQUFPLEVBQUUsU0FBUztJQUNsQixPQUFPLEVBQUUsU0FB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
