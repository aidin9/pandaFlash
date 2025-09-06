// top of webtools.js
(() => {
  'use strict';
  console.log('[webtools] build=2025-09-06.2');   // <— you should see this once in console
  …

/* webtools.js - Generic DFU + ST DFUSe helpers (single-file) */
(() => {
  'use strict';

  const dfu = {};

  // ----- DFU constants -----
  dfu.DETACH   = 0x00;
  dfu.DNLOAD   = 0x01;
  dfu.UPLOAD   = 0x02;
  dfu.GETSTATUS= 0x03;
  dfu.CLRSTATUS= 0x04;
  dfu.GETSTATE = 0x05;
  dfu.ABORT    = 0x06;

  dfu.appIDLE               = 0;
  dfu.appDETACH             = 1;
  dfu.dfuIDLE               = 2;
  dfu.dfuDNLOAD_SYNC        = 3;
  dfu.dfuDNBUSY             = 4;
  dfu.dfuDNLOAD_IDLE        = 5;
  dfu.dfuMANIFEST_SYNC      = 6;
  dfu.dfuMANIFEST           = 7;
  dfu.dfuMANIFEST_WAIT_RESET= 8;
  dfu.dfuUPLOAD_IDLE        = 9;
  dfu.dfuERROR              = 10;

  dfu.STATUS_OK = 0x00;

  const STATE_NAMES = {
    0:'appIDLE',1:'appDETACH',2:'dfuIDLE',3:'dfuDNLOAD_SYNC',4:'dfuDNBUSY',
    5:'dfuDNLOAD_IDLE',6:'dfuMANIFEST_SYNC',7:'dfuMANIFEST',
    8:'dfuMANIFEST_WAIT_RESET',9:'dfuUPLOAD_IDLE',10:'dfuERROR'
  };

  // ----- Device wrapper -----
  dfu.Device = function(device, settings) {
    this.device_ = device;
    this.settings = settings;
    this.intfNumber = settings.interface.interfaceNumber;
  };

  // ----- Interface discovery -----
  dfu.findDeviceDfuInterfaces = (device) => {
    const interfaces = [];
    for (const conf of device.configurations || []) {
      for (const intf of conf.interfaces || []) {
        for (const alt of intf.alternates || []) {
          // DFU: class 0xFE, subclass 0x01, protocol 0x01 (runtime) or 0x02 (DFU mode)
          if (alt.interfaceClass === 0xFE &&
              alt.interfaceSubclass === 0x01 &&
              (alt.interfaceProtocol === 0x01 || alt.interfaceProtocol === 0x02)) {
            interfaces.push({
              configuration: conf,
              interface: intf,
              alternate: alt,
              name: alt.interfaceName
            });
          }
        }
      }
    }
    return interfaces;
  };

  dfu.findAllDfuInterfaces = async () => {
    const devices = await navigator.usb.getDevices();
    const matches = [];
    for (const d of devices) {
      const ifs = dfu.findDeviceDfuInterfaces(d);
      for (const s of ifs) matches.push(new dfu.Device(d, s));
    }
    return matches;
  };

  // ----- Logging -----
  dfu.Device.prototype.logDebug    = function(msg){ console.log('[WebDFU Debug]', msg); };
  dfu.Device.prototype.logInfo     = function(msg){ console.log('[WebDFU Info]', msg); };
  dfu.Device.prototype.logWarning  = function(msg){ console.log('[WebDFU Warning]', msg); };
  dfu.Device.prototype.logError    = function(msg){ console.log('[WebDFU Error]', msg); };
  dfu.Device.prototype.logProgress = function(done, total){
    if (typeof total === 'number') console.log('[WebDFU Progress]', `${done}/${total}`);
    else console.log('[WebDFU Progress]', done);
  };

  // ----- Open/close/select -----
  dfu.Device.prototype.open = async function() {
    await this.device_.open();

    const confValue = this.settings.configuration.configurationValue;
    if (!this.device_.configuration || this.device_.configuration.configurationValue !== confValue) {
      await this.device_.selectConfiguration(confValue);
    }

    const intfNumber = this.settings.interface.interfaceNumber;
    if (!this.device_.configuration.interfaces[intfNumber].claimed) {
      await this.device_.claimInterface(intfNumber);
    }

    const altSetting = this.settings.alternate.alternateSetting;
    const intf = this.device_.configuration.interfaces[intfNumber];
    if (!intf.alternate || intf.alternate.alternateSetting !== altSetting || intf.alternates.length > 1) {
      try {
        await this.device_.selectAlternateInterface(intfNumber, altSetting);
      } catch (e) {
        // Chrome sometimes complains about redundant SET_INTERFACE; ignore if it's already correct
        if (!(intf.alternate && intf.alternate.alternateSetting === altSetting)) throw e;
      }
    }
  };

  dfu.Device.prototype.close = async function() {
    try { await this.device_.close(); } catch(e){ this.logDebug(e); }
  };

  // ----- Descriptor helpers (optional but useful) -----
  dfu.Device.prototype.readDeviceDescriptor = async function() {
    const GET_DESCRIPTOR = 0x06, DT_DEVICE = 0x01, wValue = DT_DEVICE << 8;
    const res = await this.device_.controlTransferIn({
      requestType:'standard', recipient:'device', request:GET_DESCRIPTOR, value:wValue, index:0
    }, 18);
    if (res.status !== 'ok') throw res.status;
    return res.data;
  };

  dfu.Device.prototype.readConfigurationDescriptor = async function(index) {
    const GET_DESCRIPTOR=0x06, DT_CONFIGURATION=0x02, wValue=(DT_CONFIGURATION<<8)|index;
    const first = await this.device_.controlTransferIn({
      requestType:'standard', recipient:'device', request:GET_DESCRIPTOR, value:wValue, index:0
    }, 4);
    if (first.status !== 'ok') throw first.status;
    const wLength = first.data.getUint16(2, true);
    const full = await this.device_.controlTransferIn({
      requestType:'standard', recipient:'device', request:GET_DESCRIPTOR, value:wValue, index:0
    }, wLength);
    if (full.status !== 'ok') throw full.status;
    return full.data;
  };

  dfu.parseFunctionalDescriptor = (data) => ({
    bLength: data.getUint8(0),
    bDescriptorType: data.getUint8(1),
    bmAttributes: data.getUint8(2),
    wDetachTimeOut: data.getUint16(3, true),
    wTransferSize: data.getUint16(5, true),
    bcdDFUVersion: data.getUint16(7, true),
  });

  dfu.parseSubDescriptors = (descriptorData) => {
    const DT_INTERFACE = 4, DT_DFU_FUNCTIONAL = 0x21;
    let remaining = descriptorData;
    const descriptors = [];
    let currIntf, inDfuIntf = false;

    while (remaining.byteLength > 2) {
      const bLength = remaining.getUint8(0);
      const bDescriptorType = remaining.getUint8(1);
      const view = new DataView(remaining.buffer.slice(0, bLength));

      if (bDescriptorType === DT_INTERFACE) {
        currIntf = {
          bLength: view.getUint8(0),
          bDescriptorType: view.getUint8(1),
          bInterfaceNumber: view.getUint8(2),
          bAlternateSetting: view.getUint8(3),
          bNumEndpoints: view.getUint8(4),
          bInterfaceClass: view.getUint8(5),
          bInterfaceSubClass: view.getUint8(6),
          bInterfaceProtocol: view.getUint8(7),
          iInterface: view.getUint8(8),
          descriptors: [],
        };
        inDfuIntf = (currIntf.bInterfaceClass === 0xFE && currIntf.bInterfaceSubClass === 0x01);
        descriptors.push(currIntf);
      } else if (inDfuIntf && bDescriptorType === DT_DFU_FUNCTIONAL) {
        const func = dfu.parseFunctionalDescriptor(view);
        descriptors.push(func);
        currIntf.descriptors.push(func);
      } else {
        const desc = { bLength, bDescriptorType, data: view };
        descriptors.push(desc);
        if (currIntf) currIntf.descriptors.push(desc);
      }
      remaining = new DataView(remaining.buffer.slice(bLength));
    }
    return descriptors;
  };

  // ----- Class control requests -----
  dfu.Device.prototype.requestOut = async function(bRequest, data, wValue=0) {
    const r = await this.device_.controlTransferOut({
      requestType:'class', recipient:'interface', request:bRequest, value:wValue, index:this.intfNumber
    }, data);
    if (r.status !== 'ok') throw r.status;
    return r.bytesWritten;
  };

  dfu.Device.prototype.requestIn = async function(bRequest, wLength, wValue=0) {
    const r = await this.device_.controlTransferIn({
      requestType:'class', recipient:'interface', request:bRequest, value:wValue, index:this.intfNumber
    }, wLength);
    if (r.status !== 'ok') throw r.status;
    return r.data;
  };

  // ----- DFU requests -----
  dfu.Device.prototype.detach     = function() { return this.requestOut(dfu.DETACH, undefined, 1000); };
  dfu.Device.prototype.download   = function(data, blockNum){ return this.requestOut(dfu.DNLOAD, data, blockNum); };
  dfu.Device.prototype.upload     = function(length, blockNum){ return this.requestIn(dfu.UPLOAD, length, blockNum); };
  dfu.Device.prototype.clearStatus= function(){ return this.requestOut(dfu.CLRSTATUS); };
  dfu.Device.prototype.getStatus  = async function(){
    const d = await this.requestIn(dfu.GETSTATUS, 6);
    return { status: d.getUint8(0), pollTimeout: (d.getUint32(1, true) & 0xFFFFFF), state: d.getUint8(4) };
  };
  dfu.Device.prototype.getState   = function(){ return this.requestIn(dfu.GETSTATE, 1).then(d=>d.getUint8(0)); };
  dfu.Device.prototype.abort      = function(){ return this.requestOut(dfu.ABORT); };

  dfu.Device.prototype.abortToIdle = async function() {
    await this.abort();
    let st = await this.getState();
    if (st === dfu.dfuERROR) {
      await this.clearStatus();
      st = await this.getState();
    }
    if (st !== dfu.dfuIDLE) throw `Failed to return to idle state after abort: state ${st}`;
  };

  // ----- DFUSe vendor extensions (STMicro) -----
  dfu.Device.prototype.dfuseCommand = async function(cmdBytes /* ArrayBuffer(5) */) {
    try { await this.abortToIdle(); } catch {}
    this.logDebug(`[DFUSe] command on block 0 (${cmdBytes.byteLength} bytes)`);
    await this.download(cmdBytes, 0);
    const st = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
    this.logDebug(`[DFUSe] status=${st.status} state=${st.state}(${STATE_NAMES[st.state]})`);
    if (st.status !== dfu.STATUS_OK) throw `DFUSe command failed state=${st.state} status=${st.status}`;
  };

  dfu.Device.prototype.dfuseSetAddress = async function(addr) {
    const b = new ArrayBuffer(5), v = new DataView(b);
    v.setUint8(0, 0x21); v.setUint32(1, addr, true);
    this.logInfo(`[DFUSe] SETADDR 0x${addr.toString(16)}`);
    await this.dfuseCommand(b);
  };

  dfu.Device.prototype.dfuseErase = async function(addr) {
    const b = new ArrayBuffer(5), v = new DataView(b);
    v.setUint8(0, 0x41); v.setUint32(1, addr, true);
    this.logInfo(`[DFUSe] ERASE  0x${addr.toString(16)}`);
    await this.dfuseCommand(b);
  };

  // Convenience: erase multiple pages then program one image
  dfu.Device.prototype.programDfuseImage = async function(startAddr, bytes, pageAddrs, xferSize, firstBlock) {
    await this.abortToIdle();
    for (const a of pageAddrs) await this.dfuseErase(a);
    await this.dfuseSetAddress(startAddr);
    await this.do_download(xferSize, bytes, /*manifestationTolerant=*/true, firstBlock);
  };

  // ----- Poll helpers -----
  dfu.Device.prototype.poll_until = async function(state_predicate) {
    let st = await this.getStatus();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    while (!state_predicate(st.state) && st.state !== dfu.dfuERROR) {
      this.logDebug(`Sleeping ${st.pollTimeout}ms (state=${st.state} ${STATE_NAMES[st.state]})`);
      await sleep(st.pollTimeout);
      st = await this.getStatus();
    }
    return st;
  };

  dfu.Device.prototype.poll_until_idle = function(idle_state) {
    return this.poll_until(s => s === idle_state);
  };

  // ----- Upload (read) -----
  dfu.Device.prototype.do_upload = async function(xfer_size, max_size = Number.POSITIVE_INFINITY, first_block = 0) {
    let transaction = first_block;
    const blocks = [];
    let bytes_read = 0;

    this.logInfo('Copying data from DFU device to browser');
    this.logProgress(0);

    let result, bytes_to_read;
    do {
      bytes_to_read = Math.min(xfer_size, max_size - bytes_read);
      result = await this.upload(bytes_to_read, transaction++);
      this.logDebug('Read ' + result.byteLength + ' bytes');
      if (result.byteLength > 0) {
        blocks.push(result);
        bytes_read += result.byteLength;
      }
      if (Number.isFinite(max_size)) this.logProgress(bytes_read, max_size);
      else this.logProgress(bytes_read);
    } while (bytes_read < max_size && result.byteLength === bytes_to_read);

    if (bytes_read === max_size) await this.abortToIdle();
    this.logInfo(`Read ${bytes_read} bytes`);
    return new Blob(blocks, { type: 'application/octet-stream' });
  };

  // ----- Download (write) -----
  // Auto-starts at block 2 for DFUSe (protocol 0x02) unless first_block is provided.
  dfu.Device.prototype.do_download = async function(xfer_size, data, manifestationTolerant, first_block) {
    let bytes_sent = 0;
    const expected_size = data.byteLength;
    let transaction = (typeof first_block === 'number')
      ? first_block
      : (this.settings?.alternate?.interfaceProtocol === 2 ? 2 : 0);

    this.logInfo('Copying data from browser to DFU device');
    this.logProgress(0, expected_size);

    while (bytes_sent < expected_size) {
      const chunk_size = Math.min(expected_size - bytes_sent, xfer_size);

      this.logDebug(`Sending block ${transaction} size ${chunk_size} bytes`);
      const bytes_written = await this.download(data.slice(bytes_sent, bytes_sent + chunk_size), transaction++);
      const st = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
      this.logDebug(`DFU status after block: state=${st.state}(${STATE_NAMES[st.state]}), status=${st.status}`);
      if (st.status !== dfu.STATUS_OK) throw `DFU DOWNLOAD failed state=${st.state}, status=${st.status}`;

      bytes_sent += bytes_written;
      this.logProgress(bytes_sent, expected_size);
    }

    this.logDebug(`Sending empty block (transaction ${transaction})`);
    await this.download(new ArrayBuffer(0), transaction++);

    this.logInfo('Wrote ' + bytes_sent + ' bytes');
    this.logInfo('Manifesting new firmware');

    if (manifestationTolerant) {
      try {
        const st = await this.poll_until(s => s === dfu.dfuIDLE || s === dfu.dfuMANIFEST_WAIT_RESET);
        if (st.state === dfu.dfuMANIFEST_WAIT_RESET) this.logDebug('Device transitioned to MANIFEST_WAIT_RESET');
        if (st.status !== dfu.STATUS_OK) throw `DFU MANIFEST failed state=${st.state}, status=${st.status}`;
      } catch (error) {
        const s = String(error);
        if (!s.endsWith('Device unavailable.') && !s.endsWith('The device was disconnected.')) {
          throw 'Error during DFU manifest: ' + error;
        }
        this.logWarning('Unable to poll final manifestation status');
      }
    } else {
      try {
        const final_status = await this.getStatus();
        this.logDebug(`Final DFU status: state=${final_status.state}, status=${final_status.status}`);
      } catch (e) {
        this.logDebug('Manifest GET_STATUS poll error: ' + e);
      }
    }

    // Reset (ok if it fails due to disconnect)
    try { await this.device_.reset(); }
    catch (error) {
      if (error === 'NetworkError: Unable to reset the device.' ||
          error === 'NotFoundError: Device unavailable.' ||
          error === 'NotFoundError: The device was disconnected.') {
        this.logDebug('Ignored reset error');
      } else {
        throw 'Error during reset for manifestation: ' + error;
      }
    }
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) module.exports = dfu;
  if (typeof window !== 'undefined') window.dfu = dfu;
})();
