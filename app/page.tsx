'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';

/** ---------- Small logging helper ---------- */
function useLogger() {
  const [lines, setLines] = useState<string[]>([]);
  const log = useCallback((...args: unknown[]) => {
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    // eslint-disable-next-line no-console
    console.log(msg);
    setLines(prev => [...prev, msg]);
  }, []);
  const clear = () => setLines([]);
  return { lines, log, clear };
}

/** ---------- DFU wrapper with DFUSe helpers ---------- */
type DfuSettings = {
  configuration: USBConfiguration;
  interface: USBInterface;
  alternate: USBAlternateInterface;
  name?: string | null;
};

class DfuDevice {
  device: USBDevice;
  settings: DfuSettings;
  logProgress: (done: number, total?: number) => void = () => {};

  constructor(device: USBDevice, settings: DfuSettings) {
    this.device = device;
    this.settings = settings;
  }

  // ---- open/claim/select alt ----
  async open() {
    if (!this.device.opened) await this.device.open();
    if (!this.device.configuration || this.device.configuration.configurationValue !== this.settings.configuration.configurationValue) {
      await this.device.selectConfiguration(this.settings.configuration.configurationValue);
    }
    const intfNumber = this.settings.interface.interfaceNumber;
    if (!this.device.configuration!.interfaces[intfNumber].claimed) {
      await this.device.claimInterface(intfNumber);
    }
    const alt = this.settings.alternate.alternateSetting ?? 0;
    const intf = this.device.configuration!.interfaces[intfNumber];
    if (!intf.alternate || intf.alternate.alternateSetting !== alt || intf.alternates.length > 1) {
      try {
        await this.device.selectAlternateInterface(intfNumber, alt);
      } catch (e) {
        if (!intf.alternate || intf.alternate.alternateSetting !== alt) throw e;
      }
    }
  }

  async close() {
    try { if (this.device.opened) await this.device.close(); } catch { /* ignore */ }
  }

  // ---- core class control helpers ----
  private async requestOut(request: number, data?: BufferSource, value = 0) {
    const r = await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request,
      value,
      index: this.settings.interface.interfaceNumber,
    }, data);
    if (r.status !== 'ok') throw new Error(`controlTransferOut failed: ${r.status}`);
    return r.bytesWritten ?? 0;
  }

  private async requestIn(request: number, length: number, value = 0) {
    const r = await this.device.controlTransferIn({
      requestType: 'class',
      recipient: 'interface',
      request,
      value,
      index: this.settings.interface.interfaceNumber,
    }, length);
    if (r.status !== 'ok') throw new Error(`controlTransferIn failed: ${r.status}`);
    return r.data!;
  }

  // ---- DFU constants & helpers ----
  private static readonly DFU = {
    DETACH: 0x00,
    DNLOAD: 0x01,
    UPLOAD: 0x02,
    GETSTATUS: 0x03,
    CLRSTATUS: 0x04,
    GETSTATE: 0x05,
    ABORT: 0x06,
  } as const;

  private static readonly STATE = {
    appIDLE: 0,
    appDETACH: 1,
    dfuIDLE: 2,
    dfuDNLOAD_SYNC: 3,
    dfuDNBUSY: 4,
    dfuDNLOAD_IDLE: 5,
    dfuMANIFEST_SYNC: 6,
    dfuMANIFEST: 7,
    dfuMANIFEST_WAIT_RESET: 8,
    dfuUPLOAD_IDLE: 9,
    dfuERROR: 10,
  } as const;

  private static readonly STATE_NAME: Record<number, string> = {
    0:'appIDLE',1:'appDETACH',2:'dfuIDLE',3:'dfuDNLOAD_SYNC',4:'dfuDNBUSY',5:'dfuDNLOAD_IDLE',
    6:'dfuMANIFEST_SYNC',7:'dfuMANIFEST',8:'dfuMANIFEST_WAIT_RESET',9:'dfuUPLOAD_IDLE',10:'dfuERROR'
  };

  private async getStatus() {
    const d = await this.requestIn(DfuDevice.DFU.GETSTATUS, 6);
    return { status: d.getUint8(0), pollTimeout: (d.getUint32(1, true) & 0xFFFFFF), state: d.getUint8(4) };
  }
  private async getState() {
    const d = await this.requestIn(DfuDevice.DFU.GETSTATE, 1);
    return d.getUint8(0);
  }

  async abortToIdle() {
    await this.requestOut(DfuDevice.DFU.ABORT);
    let s = await this.getState();
    if (s === DfuDevice.STATE.dfuERROR) {
      await this.requestOut(DfuDevice.DFU.CLRSTATUS);
      s = await this.getState();
    }
    if (s !== DfuDevice.STATE.dfuIDLE) throw new Error(`Failed to return to IDLE, state=${s}`);
  }

  private async pollUntil(targetState: number) {
    let st = await this.getStatus();
    const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
    while (st.state !== targetState && st.state !== DfuDevice.STATE.dfuERROR) {
      // eslint-disable-next-line no-console
      console.debug(`[DFU] sleep ${st.pollTimeout}ms (state=${st.state}/${DfuDevice.STATE_NAME[st.state]})`);
      await sleep(st.pollTimeout);
      st = await this.getStatus();
    }
    return st;
  }

  private async dnloadBlock(data: ArrayBuffer, blockNum: number) {
    await this.requestOut(DfuDevice.DFU.DNLOAD, data, blockNum);
    return this.pollUntil(DfuDevice.STATE.dfuDNLOAD_IDLE);
  }

  // ---- DFUSe vendor extensions ----
  async dfuseSetAddress(addr: number) {
    const b = new ArrayBuffer(5); const v = new DataView(b);
    v.setUint8(0, 0x21); v.setUint32(1, addr, true);
    await this.abortToIdle();
    const st = await this.dnloadBlock(b, 0);
    if (st.status !== 0) throw new Error(`DFUSe SETADDR failed: status=${st.status}, state=${st.state}`);
  }

  async dfuseErase(addr: number) {
    const b = new ArrayBuffer(5); const v = new DataView(b);
    v.setUint8(0, 0x41); v.setUint32(1, addr, true);
    await this.abortToIdle();
    const st = await this.dnloadBlock(b, 0);
    if (st.status !== 0) throw new Error(`DFUSe ERASE failed: status=${st.status}, state=${st.state}`);
  }

  /** Read DFU Functional descriptor for this interface/alt and return wTransferSize */
  async getTransferSize(): Promise<number> {
    const GET_DESCRIPTOR = 0x06;
    const DT_CONFIGURATION = 0x02;
    const wValue = (DT_CONFIGURATION << 8) | this.settings.configuration.configurationValue;

    // Read config header to get total length
    const first = await this.device.controlTransferIn(
      { requestType: 'standard', recipient: 'device', request: GET_DESCRIPTOR, value: wValue, index: 0 },
      4
    );
    if (first.status !== 'ok') throw new Error(String(first.status));
    const wTotalLength = first.data!.getUint16(2, true);

    // Read full configuration descriptor
    const full = await this.device.controlTransferIn(
      { requestType: 'standard', recipient: 'device', request: GET_DESCRIPTOR, value: wValue, index: 0 },
      wTotalLength
    );
    if (full.status !== 'ok') throw new Error(String(full.status));
    const bytes = new DataView(full.data!.buffer);

    // Walk descriptors to find our interface/alt, then its DFU Functional (type 0x21)
    let offset = 9; // skip config header (9 bytes)
    let inTargetIntf = false;

    while (offset + 2 <= bytes.byteLength) {
      const bLength = bytes.getUint8(offset);
      const bType = bytes.getUint8(offset + 1);
      if (bLength < 2) break;

      if (bType === 0x04 /* INTERFACE */) {
        const intfNum = bytes.getUint8(offset + 2);
        const alt     = bytes.getUint8(offset + 3);
        const cls     = bytes.getUint8(offset + 5);
        const subcls  = bytes.getUint8(offset + 6);
        const proto   = bytes.getUint8(offset + 7);
        inTargetIntf =
          intfNum === this.settings.interface.interfaceNumber &&
          alt     === this.settings.alternate.alternateSetting &&
          cls     === 0xfe && subcls === 0x01 && proto === 0x02; // DFU mode (DFUSe)
      } else if (inTargetIntf && bType === 0x21 /* DFU Functional */) {
        const wTransferSize = bytes.getUint16(offset + 5, true);
        return wTransferSize || 2048;
      }

      offset += bLength;
    }

    // Fallback if not found
    return 2048;
  }

  /** Write data; for DFUSe we start at block 2 (block 0 is commands) */
  async do_download(xferSize: number, data: ArrayBuffer, manifestationTolerant: boolean, firstBlock = 2) {
    await this.abortToIdle();

    const view = new Uint8Array(data);
    let sent = 0;
    let block = firstBlock;

    this.logProgress(0, view.byteLength);

    while (sent < view.byteLength) {
      const size = Math.min(xferSize, view.byteLength - sent);
      console.log(`[DFU] Sending block ${block} size ${size}`);
      const st = await this.dnloadBlock(view.slice(sent, sent + size).buffer, block++);
      if (st.status !== 0) throw new Error(`DFU DOWNLOAD failed state=${st.state} status=${st.status}`);
      sent += size;
      this.logProgress(sent, view.byteLength);
    }

    console.log(`[DFU] Sending final ZLP (block ${block})`);
    await this.requestOut(DfuDevice.DFU.DNLOAD, new ArrayBuffer(0), block++);

    if (manifestationTolerant) {
      const fin = await this.pollUntil(DfuDevice.STATE.dfuIDLE);
      if (fin.status !== 0) throw new Error(`DFU MANIFEST failed state=${fin.state} status=${fin.status}`);
    } else {
      try { await this.getStatus(); } catch { /* ignore */ }
    }
  }
}

/** ---------- Helpers to pick DFUSe alt/interface ---------- */
function findDfuInterfaces(device: USBDevice): DfuSettings[] {
  const matches: DfuSettings[] = [];
  for (const conf of device.configurations || []) {
    for (const intf of conf.interfaces || []) {
      for (const alt of intf.alternates || []) {
        if (alt.interfaceClass === 0xfe && alt.interfaceSubclass === 0x01 && alt.interfaceProtocol === 0x02) {
          matches.push({ configuration: conf, interface: intf, alternate: alt, name: alt.interfaceName });
        }
      }
    }
  }
  return matches;
}

/** ---------- Page Component ---------- */
export default function Page() {
  const { lines, log, clear } = useLogger();
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState<{done: number; total: number}>({ done: 0, total: 0 });
  const [pandaBin, setPandaBin] = useState<ArrayBuffer | null>(null);
  const [bootstubBin, setBootstubBin] = useState<ArrayBuffer | null>(null);
  const devRef = useRef<DfuDevice | null>(null);

  const onPickFiles = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = ev.currentTarget.files;
    if (!files) return;
    for (const f of Array.from(files)) {
      const buf = await f.arrayBuffer();
      if (f.name.toLowerCase().includes('bootstub')) {
        setBootstubBin(buf);
        log(`[v0] Loaded ${f.name} (${buf.byteLength} bytes)`);
      } else {
        setPandaBin(buf);
        log(`[v0] Loaded ${f.name} (${buf.byteLength} bytes)`);
      }
    }
  };

  const connect = useCallback(async () => {
    clear();
    try {
      const device = await navigator.usb.requestDevice({
        filters: [
          { vendorId: 0x0483, productId: 0xdf11 }, // ST DFU (DFUSe)
          { classCode: 0xfe, subclassCode: 0x01 }, // DFU class
        ],
      });
      log('[v0] Found device:', device);

      const dfuIfs = findDfuInterfaces(device);
      if (dfuIfs.length === 0) {
        throw new Error('No DFU (protocol 2) interface found. Put device in DFU mode.');
      }
      const settings = dfuIfs[0];
      log('[v0] Selected DFU interface/alt:', settings.interface.interfaceNumber, settings.alternate.alternateSetting);

      const dev = new DfuDevice(device, settings);
      dev.logProgress = (done, total) => setProgress({ done, total: total ?? done });
      await dev.open();
      devRef.current = dev;
      setConnected(true);
      log('[v0] Device opened successfully');
    } catch (e: any) {
      log('[v0] Connect failed:', e?.message || String(e));
      setConnected(false);
    }
  }, [clear, log]);

  const disconnect = useCallback(async () => {
    try { await devRef.current?.close(); } catch {}
    devRef.current = null;
    setConnected(false);
    log('[v0] Disconnected.');
  }, [log]);

  // helper: try with transfer size then fall back to smaller sizes if the device stalls
  const writeWithFallback = useCallback(async (dev: DfuDevice, data: ArrayBuffer, sizes: number[]) => {
    let lastErr: unknown;
    const tried = new Set<number>();
    for (const s of sizes) {
      if (tried.has(s)) continue;
      tried.add(s);
      try {
        log(`[v0] Using wTransferSize = ${s}`);
        await dev.do_download(s, data, /*manifest*/true, /*firstBlock*/2);
        return;
      } catch (e) {
        lastErr = e;
        log(`[v0] Transfer size ${s} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw lastErr;
  }, [log]);

  const flash = useCallback(async () => {
    const dev = devRef.current;
    if (!dev) return log('[v0] No device connected');
    if (!pandaBin || !bootstubBin) return log('[v0] Please select panda.bin and bootstub.panda.bin');

    try {
      log(`[v0] Firmware data prepared — Panda: ${pandaBin.byteLength} bytes, Bootstub: ${bootstubBin.byteLength} bytes`);

      // Read the device's transfer size
      const transferSize = await dev.getTransferSize();
      // Build a sensible fallback ladder
      const ladder = [transferSize, 2048, 1024, 512, 256];

      // ---- panda.bin @ 0x08004000 (erase three 16KiB pages) ----
      log('[v0] DFUSe: ERASE panda pages');
      await dev.dfuseErase(0x08004000);
      await dev.dfuseErase(0x08008000);
      await dev.dfuseErase(0x0800C000);
      log('[v0] DFUSe: SETADDR 0x08004000');
      await dev.dfuseSetAddress(0x08004000);
      log('[v0] Writing panda.bin (start block 2)');
      await writeWithFallback(dev, pandaBin, ladder);

      // ---- bootstub @ 0x08000000 (erase one 16KiB page) ----
      log('[v0] DFUSe: ERASE bootstub page');
      await dev.dfuseErase(0x08000000);
      log('[v0] DFUSe: SETADDR 0x08000000');
      await dev.dfuseSetAddress(0x08000000);
      log('[v0] Writing bootstub.panda.bin (start block 2)');
      await writeWithFallback(dev, bootstubBin, ladder);

      try { await (dev as any).requestOut?.(0x00, 0, 1000); } catch {}
      log('[v0] Flash complete 🎉');
    } catch (e: any) {
      log('[v0] Flash failed:', e?.message || String(e));
    }
  }, [bootstubBin, log, pandaBin, writeWithFallback]);

  const progressPct = useMemo(() => {
    if (!progress.total) return 0;
    return Math.min(100, Math.floor((progress.done / progress.total) * 100));
  }, [progress]);

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-semibold">White Panda – Web DFU (DFUSe) Flasher</h1>

      <div className="flex gap-2">
        <button
          className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
          onClick={connect}
          disabled={connected}
        >
          Connect
        </button>
        <button
          className="px-4 py-2 rounded bg-gray-600 text-white disabled:opacity-50"
          onClick={disconnect}
          disabled={!connected}
        >
          Disconnect
        </button>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium">Upload binaries (panda.bin and bootstub.panda.bin)</label>
        <input type="file" multiple onChange={onPickFiles} />
      </div>

      <div className="space-y-2">
        <div className="h-3 w-full bg-gray-200 rounded">
          <div
            className="h-3 bg-green-600 rounded"
            style={{ width: `${progressPct}%`, transition: 'width .2s ease' }}
          />
        </div>
        <div className="text-sm text-gray-600">
          Progress: {progress.done}/{progress.total} bytes ({progressPct}%)
        </div>
      </div>

      <button
        className="px-4 py-2 rounded bg-emerald-600 text-white disabled:opacity-50"
        onClick={flash}
        disabled={!connected || !pandaBin || !bootstubBin}
      >
        Flash Firmware
      </button>

      <div className="mt-4">
        <div className="text-sm font-medium mb-1">Log</div>
        <div className="h-56 overflow-auto rounded border p-2 text-xs bg-black text-green-300">
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-500">
        You should see <code>ERASE</code> and <code>SETADDR</code> logs, then the first data block as <code>block 2</code>.
        If a transfer size is too large, the app automatically retries with a smaller one.
      </p>
    </div>
  );
}
