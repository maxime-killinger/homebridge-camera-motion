'use strict';

const fs = require('fs');
const FIFO = require('fifo-js');

let Service, Characteristic, UUIDGen, StreamController, Accessory, hap;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  StreamController = homebridge.hap.StreamController;
  Accessory = homebridge.platformAccessory;
  hap = homebridge.hap;

  homebridge.registerPlatform('homebridge-camera-motion', 'CameraMotion', CameraMotionPlatform, true);
};

class CameraMotionPlatform
{
  constructor(log, config, api) {
    log(`CameraMotion Platform Plugin starting`);
    this.log = log;
    this.api = api;
    config = config || {};
    this.name = config.name || 'CameraMotionPlatform';

    this.motionAccessory = new CameraMotionAccessory(log, config, api);

    this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
  }

  accessories(cb) {
    cb([this.motionAccessory]);
  }

  didFinishLaunching() {
    if (global._mcp_launched) return; // call only once
    global._mcp_launched = true; // TODO: really, why is this called twice? from where?

    const cameraName = 'Camera1';
    const uuid = UUIDGen.generate(cameraName);
    console.log('uuid=',uuid);
    const cameraAccessory = new Accessory(cameraName, uuid, hap.Accessory.Categories.CAMERA);
    cameraAccessory.configureCameraSource(new CameraMotionSource(hap));
    const configuredAccessories = [cameraAccessory];
    this.api.publishCameraAccessories('CameraMotion', configuredAccessories);
    this.log(`published camera`);
  }
}

class CameraMotionAccessory
{
  constructor(log, config, api) {
    log(`CameraMotion accessory starting`);
    this.log = log;
    this.api = api;
    config = config || {};
    this.name = config.name || 'CameraMotionAccessory';

    this.pipePath = config.pipePath || '/tmp/camera-pipe';
    this.timeout = config.timeout !== undefined ? config.timeout : 2000;

    this.pipe = new FIFO(this.pipePath);
    this.pipe.setReader(this.onPipeRead.bind(this));

    this.motionService = new Service.MotionSensor(this.name);
    this.setMotion(false);
  }

  setMotion(detected) {
    this.motionService
      .getCharacteristic(Characteristic.MotionDetected)
      .setValue(detected);
  }

  onPipeRead(text) {
    console.log(`got from pipe: |${text}|`);
    // on_picture_save printf '%f\t%n\t%v\t%i\t%J\t%K\t%L\t%N\t%D\n' > /tmp/camera-pipe
    // http://htmlpreview.github.io/?https://github.com/Motion-Project/motion/blob/master/motion_guide.html#conversion_specifiers
    // %f filename with full path
    // %n number indicating filetype
    // %v event
    // %i width of motion area
    // %J height of motion area
    // %K X coordinates of motion center
    // %L Y coordinates of motion center
    // %N noise level
    // %D changed pixels
    const [filename, filetype, event, width, height, x, y, noise, dpixels] = text.trim().split('\t');
    console.log('filename is',filename);

    this.setMotion(true);

    setTimeout(() => this.setMotion(false), this.timeout); // TODO: is this how this works?
  }

  getServices() {
    return [this.motionService];
  }
}

class CameraMotionSource
{
  constructor(hap) {
    this.hap = hap;

    this.services = []; // TODO: where is this used?

    // Create control service
    this.controlService = new Service.CameraControl();

    // Create stream controller(s) (only one for now TODO: more)

    const videoResolutions = [
        // width, height, fps
        [1920, 1080, 30],
        [320, 240, 15],
        [1280, 960, 30],
        [1280, 720, 30],
        [1024, 768, 30],
        [640, 480, 30],
        [640, 360, 30],
        [480, 360, 30],
        [480, 270, 30],
        [320, 240, 30],
        [320, 180, 30],
   ];

   // see https://github.com/KhaosT/homebridge-camera-ffmpeg/blob/master/ffmpeg.js
   const options = {
     proxy: false, // Requires RTP/RTCP MUX Proxy
     srtp: true, // Supports SRTP AES_CM_128_HMAC_SHA1_80 encryption
     video: {
       resolutions: videoResolutions,
       codec: {
         profiles: [0, 1, 2], // Enum, please refer StreamController.VideoCodecParamProfileIDTypes
         levels: [0, 1, 2] // Enum, please refer StreamController.VideoCodecParamLevelTypes
       }
     },
     audio: {
       codecs: [
         {
           type: "OPUS", // Audio Codec
           samplerate: 24 // 8, 16, 24 KHz
         },
         {
           type: "AAC-eld",
           samplerate: 16
         }
       ]
     }
   };


   this.streamController = new StreamController(0, options, this);
   this.services.push(this.streamController.service);
  }

  handleCloseConnection(connectionID) {
    this.streamController.handleCloseConnection(connectionID);
  }

  // stolen from https://github.com/KhaosT/homebridge-camera-ffmpeg/blob/master/ffmpeg.js TODO: why can't this be in homebridge itself?
  prepareStream(request, cb) {
    var sessionInfo = {};
  
    let sessionID = request["sessionID"];
    let targetAddress = request["targetAddress"];
  
    sessionInfo["address"] = targetAddress;
  
    var response = {};
  
    let videoInfo = request["video"];
    if (videoInfo) {
      let targetPort = videoInfo["port"];
      let srtp_key = videoInfo["srtp_key"];
      let srtp_salt = videoInfo["srtp_salt"];
  
      let videoResp = {
        port: targetPort,
        ssrc: 1,
        srtp_key: srtp_key,
        srtp_salt: srtp_salt
      };
  
      response["video"] = videoResp;
  
      sessionInfo["video_port"] = targetPort;
      sessionInfo["video_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
      sessionInfo["video_ssrc"] = 1; 
    }
  
    let audioInfo = request["audio"];
    if (audioInfo) {
      let targetPort = audioInfo["port"];
      let srtp_key = audioInfo["srtp_key"];
      let srtp_salt = audioInfo["srtp_salt"];
  
      let audioResp = {
        port: targetPort,
        ssrc: 1,
        srtp_key: srtp_key,
        srtp_salt: srtp_salt
      };
  
      response["audio"] = audioResp;
  
      sessionInfo["audio_port"] = targetPort;
      sessionInfo["audio_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
      sessionInfo["audio_ssrc"] = 1; 
    }
  }

  handleStreamRequest(request) {
    console.log('TODO: handleStreamRequest',request);
  }

  handleSnapshotRequest(request, cb) {
    console.log('handleSnapshotRequest',request);
    const filename = '/tmp/lastsnap.jpg'; // TODO: configurable target_dir
    fs.readFile('/tmp/lastsnap.jpg', (err, data) => {
      if (err) return cb(err);

      // TODO: scale to requested dimensions
      cb(null, data);
    });
  }
}

