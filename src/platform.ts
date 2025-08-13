import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { exec } from 'child_process';
import { promisify } from 'util';

import { SingleColorLedStrip } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

const execAsync = promisify(exec);



/**
 * MagicHome Homebridge Platform
 * 
 * Manages device configuration, MAC-to-IP resolution, and accessory registration.
 */
export class MagichomeHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * Restore cached accessories from disk at startup
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Discover and register configured MagicHome devices
   */
  async discoverDevices() {
    this.log.info('Starting MagicHome device discovery...');

    // get the devices from the config
    const devices = this.config.lights || [];

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of devices) {
      // Validate address type
      const isIP = this.isValidIPAddress(device.address);
      const isMAC = this.isValidMACAddress(device.address);
      
      if (!isIP && !isMAC) {
        this.log.error(`Invalid address format for device "${device.name}": ${device.address}`);
        this.log.error('Address must be a valid IP address or MAC address');
        continue; // Skip this device
      }
      
      // Log address type for debugging
      const addressType = isIP ? 'IP address' : 'MAC address';
      this.log.info(`Processing device "${device.name}" with ${addressType}: ${device.address}`);
      
      let deviceAddress = device.address;
      
      if (isMAC) {
        this.log.info(`MAC address detected for "${device.name}". Resolving to IP address...`);
        
        const resolvedIP = await this.resolveMacToIP(device.address);
        if (resolvedIP) {
          this.log.info(`Successfully resolved MAC ${device.address} to IP ${resolvedIP}`);
          deviceAddress = resolvedIP;
        } else {
          this.log.error(`Failed to resolve MAC address ${device.address} to IP address`);
          this.log.error(`Device "${device.name}" will be skipped. Ensure the device is online and on the same network.`);
          continue; // Skip this device if we can't resolve its IP
        }
      }

      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.address);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // Update the accessory context with resolved IP address if needed
        if (deviceAddress !== device.address) {
          existingAccessory.context.device = {
            ...device,
            address: deviceAddress, // Use resolved IP address
            originalAddress: device.address, // Keep original address for reference
          };
          this.api.updatePlatformAccessories([existingAccessory]);
        }

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        new SingleColorLedStrip(this, existingAccessory);

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, e.g.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        // Use resolved IP address for MAC addresses
        accessory.context.device = {
          ...device,
          address: deviceAddress, // Use resolved IP address
          originalAddress: device.address, // Keep original address for reference
        };

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        new SingleColorLedStrip(this, accessory);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    // you can also deal with accessories from the cache which are no longer present by removing them from Homebridge
    // for example, if your plugin logs into a cloud account to retrieve a device list, and a user has previously removed a device
    // from this cloud account, then this device will no longer be present in the device list but will still be in the Homebridge cache
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /**
   * Validate IPv4 address format
   */
  private isValidIPAddress(address: string): boolean {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipv4Regex.test(address);
  }

  /**
   * Validate MAC address format (AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF, AABBCCDDEEFF)
   */
  private isValidMACAddress(address: string): boolean {
    // Format with colons or hyphens: AA:BB:CC:DD:EE:FF or AA-BB-CC-DD-EE-FF
    const macWithSeparators = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
    // Format without separators: AABBCCDDEEFF
    const macWithoutSeparators = /^[0-9A-Fa-f]{12}$/;
    
    return macWithSeparators.test(address) || macWithoutSeparators.test(address);
  }

  /**
   * Resolve MAC to IP address via ARP table (Linux/macOS)
   */
  private async resolveMacToIP(macAddress: string): Promise<string | null> {
    try {
      // Normalize MAC address format (remove colons/hyphens and convert to lowercase)
      const normalizedMac = macAddress.replace(/[:-]/g, '').toLowerCase();
      
      const { stdout } = await execAsync('arp -a');
      const arpEntries = stdout.split('\n');
      
      // Parse ARP table entries to find matching MAC address
      for (const entry of arpEntries) {
        // Linux/macOS format: hostname (192.168.1.90) at aa:bb:cc:dd:ee:ff [ether] on en0
        const match = entry.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([a-fA-F0-9:]{17})/);
        
        if (match) {
          const [, ip, mac] = match;
          const entryMac = mac.replace(/[:-]/g, '').toLowerCase();
          
          if (entryMac === normalizedMac) {
            return ip;
          }
        }
      }
      
      return null; // MAC address not found in ARP table
    } catch (error) {
      this.log.error('Error resolving MAC to IP:', error);
      return null;
    }
  }
}
