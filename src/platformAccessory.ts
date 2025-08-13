import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { Control } from 'magic-home';

import type { MagichomeHomebridgePlatform } from './platform.js';



/**
 * Magichome Single Color LED Strip Accessory
 * 
 * Controls MagicHome single color LED strips via HomeKit.
 * Maps brightness (0-100%) to red channel (0-255).
 */
export class SingleColorLedStrip {
  private service: Service;
  private light: Control;
  private deviceIP: string;
  private deviceName: string;
  private pollingIntervalMs: number;
  private pollingTimer?: NodeJS.Timeout;

  /**
   * Internal state cache - updated immediately and via polling
   */
  private accessoryState = {
    On: false,
    Brightness: 100,
  };

  constructor(
    private readonly platform: MagichomeHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Get device IP and name from accessory context
    this.deviceIP = accessory.context.device.address;
    this.deviceName = accessory.context.device.name;
    
    // Get polling interval from platform config (in seconds), convert to milliseconds
    this.pollingIntervalMs = (platform.config.pollingInterval || 5) * 1000;
    
    // Initialize the magic-home Control instance
    this.light = new Control(this.deviceIP);

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'MagicHome')
      .setCharacteristic(this.platform.Characteristic.Model, 'Single Color LED Strip')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceIP);

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // Query the current state of the light initially
    this.queryAndUpdateState();

    // Start polling every 10 seconds
    this.startPolling();

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.deviceName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this)) // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this)); // GET - bind to the `getOn` method below

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this)) // SET - bind to the `setBrightness` method below
      .onGet(this.getBrightness.bind(this)); // GET - bind to the `getBrightness` method below
  }

  /**
   * Handle on/off requests from HomeKit
   */
  async setOn(value: CharacteristicValue) {
    const isOn = value as boolean;
    
    // Update internal state immediately
    this.accessoryState.On = isOn;
    
    // Send command asynchronously without blocking HomeKit response
    if (isOn) {
      this.light.turnOn()
        .then(() => {
          this.platform.log.info(`Light "${this.deviceName}" turned ON`);
        })
        .catch((error: unknown) => {
          this.platform.log.error(`Failed to turn on light "${this.deviceName}":`, error);
        });
    } else {
      this.light.turnOff()
        .then(() => {
          this.platform.log.info(`Light "${this.deviceName}" turned OFF`);
        })
        .catch((error: unknown) => {
          this.platform.log.error(`Failed to turn off light "${this.deviceName}":`, error);
        });
    }
  }

  /**
   * Handle on/off status requests from HomeKit
   */
  async getOn(): Promise<CharacteristicValue> {
    // implement your own code to check if the device is on
    const isOn = this.accessoryState.On;

    this.platform.log.info('Get Characteristic On ->', isOn);

    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    return isOn;
  }

  /**
   * Handle brightness change requests from HomeKit
   */
  async setBrightness(value: CharacteristicValue) {
    const brightness = value as number;
    
    // Map brightness from HomeKit range (0-100) to color range (0-255)
    const redValue = Math.round((brightness / 100) * 255);
    
    // Update internal state immediately
    this.accessoryState.Brightness = brightness;
    
    // Set color asynchronously without blocking HomeKit response
    this.light.setColor(redValue, 0, 0)
      .then(() => {
        this.platform.log.info(`Light "${this.deviceName}" brightness set to ${brightness}% (red: ${redValue})`);
      })
      .catch((error: unknown) => {
        this.platform.log.error(`Failed to set brightness ${brightness}% for light "${this.deviceName}":`, error);
      });
  }

  /**
   * Handle brightness status requests from HomeKit
   */
  async getBrightness(): Promise<CharacteristicValue> {
    // implement your own code to check the current brightness
    const brightness = this.accessoryState.Brightness;

    this.platform.log.info('Get Characteristic Brightness ->', brightness);

    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    return brightness;
  }

  /**
   * Poll device state and update HomeKit characteristics if changed
   */
  private async queryAndUpdateState(): Promise<void> {
    this.light.queryState()
      .then((state) => {
        const deviceState = state as {
          type: number;
          on: boolean;
          mode: string;
          pattern: string | null;
          speed: number;
          color: { red: number; green: number; blue: number };
          warm_white: number;
          cold_white: number;
        };
        
        const currentOn = deviceState.on;
        // Map brightness from color.red (0-255) to HomeKit range (0-100)
        const currentBrightness = Math.round((deviceState.color.red / 255) * 100);
        
        // Check if on/off state has changed
        if (this.accessoryState.On !== currentOn) {
          this.platform.log.info(`Light "${this.deviceName}" state changed: ${currentOn ? 'ON' : 'OFF'}`);
          
          // Update internal state
          this.accessoryState.On = currentOn;
          
          // Update HomeKit characteristic
          this.service.updateCharacteristic(this.platform.Characteristic.On, currentOn);
        }
        
        // Check if brightness has changed
        if (this.accessoryState.Brightness !== currentBrightness) {
          this.platform.log.info(`Light "${this.deviceName}" brightness changed: ${currentBrightness}% (red: ${deviceState.color.red})`);
          
          // Update internal state
          this.accessoryState.Brightness = currentBrightness;
          
          // Update HomeKit characteristic
          this.service.updateCharacteristic(this.platform.Characteristic.Brightness, currentBrightness);
        }
      })
      .catch((error: unknown) => {
        this.platform.log.error(`Failed to query state of light "${this.deviceName}":`, error);
      });
  }

  /**
   * Start periodic device polling
   */
  private async startPolling(): Promise<void> {
    this.platform.log.info(`Starting polling for light "${this.deviceName}" every ${this.pollingIntervalMs / 1000} seconds`);
    
    this.pollingTimer = setInterval(() => {
      this.queryAndUpdateState();
    }, this.pollingIntervalMs);
  }

  /**
   * Stop device polling
   */
  private async stopPolling(): Promise<void> {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
      this.platform.log.info(`Stopped polling for light "${this.deviceName}"`);
    }
  }
}
