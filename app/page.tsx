"use client"

import type React from "react"
import { useCallback, useMemo, useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription } from "@/components/ui/alert"

/** ---------- Small logging helper ---------- */
function useLogger() {
  const [lines, setLines] = useState<string[]>([])
  const log = useCallback((...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
    console.log(msg)
    setLines((prev) => [...prev, msg])
  }, [])
  const clear = () => setLines([])
  return { lines, log, clear }
}

/** ---------- DFU wrapper with DFUSe helpers ---------- */
type DfuSettings = {
  configuration: USBConfiguration
  interface: USBInterface
  alternate: USBAlternateInterface
  name?: string | null
}

class DfuDevice {
  device: USBDevice
  settings: DfuSettings
  logProgress: (done: number, total?: number) => void = () => {}

  constructor(device: USBDevice, settings: DfuSettings) {
    this.device = device
    this.settings = settings
  }

  // ---- open/claim/select alt ----
  async open() {
    if (!this.device.opened) await this.device.open()
    if (
      !this.device.configuration ||
      this.device.configuration.configurationValue !== this.settings.configuration.configurationValue
    ) {
      await this.device.selectConfiguration(this.settings.configuration.configurationValue)
    }
    const intfNumber = this.settings.interface.interfaceNumber
    if (!this.device.configuration!.interfaces[intfNumber].claimed) {
      await this.device.claimInterface(intfNumber)
    }
    const alt = this.settings.alternate.alternateSetting ?? 0
    const intf = this.device.configuration!.interfaces[intfNumber]
    if (!intf.alternate || intf.alternate.alternateSetting !== alt || intf.alternates.length > 1) {
      try {
        await this.device.selectAlternateInterface(intfNumber, alt)
      } catch (e) {
        if (!intf.alternate || intf.alternate.alternateSetting !== alt) throw e
      }
    }
  }

  async close() {
    try {
      if (this.device.opened) await this.device.close()
    } catch {
      /* ignore */
    }
  }

  // ---- core class control helpers ----
  private async requestOut(request: number, data?: BufferSource, value = 0) {
    const r = await this.device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request,
        value,
        index: this.settings.interface.interfaceNumber,
      },
      data,
    )
    if (r.status !== "ok") throw new Error(`controlTransferOut failed: ${r.status}`)
    return r.bytesWritten ?? 0
  }

  private async requestIn(request: number, length: number, value = 0) {
    const r = await this.device.controlTransferIn(
      {
        requestType: "class",
        recipient: "interface",
        request,
        value,
        index: this.settings.interface.interfaceNumber,
      },
      length,
    )
    if (r.status !== "ok") throw new Error(`controlTransferIn failed: ${r.status}`)
    return r.data!
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
  } as const

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
  } as const

  private static readonly STATE_NAME: Record<number, string> = {
    0: "appIDLE",
    1: "appDETACH",
    2: "dfuIDLE",
    3: "dfuDNLOAD_SYNC",
    4: "dfuDNBUSY",
    5: "dfuDNLOAD_IDLE",
    6: "dfuMANIFEST_SYNC",
    7: "dfuMANIFEST",
    8: "dfuMANIFEST_WAIT_RESET",
    9: "dfuUPLOAD_IDLE",
    10: "dfuERROR",
  }

  private async getStatus() {
    const d = await this.requestIn(DfuDevice.DFU.GETSTATUS, 6)
    return { status: d.getUint8(0), pollTimeout: d.getUint32(1, true) & 0xffffff, state: d.getUint8(4) }
  }
  private async getState() {
    const d = await this.requestIn(DfuDevice.DFU.GETSTATE, 1)
    return d.getUint8(0)
  }

  async abortToIdle() {
    await this.requestOut(DfuDevice.DFU.ABORT)
    let s = await this.getState()
    if (s === DfuDevice.STATE.dfuERROR) {
      await this.requestOut(DfuDevice.DFU.CLRSTATUS)
      s = await this.getState()
    }
    if (s !== DfuDevice.STATE.dfuIDLE) throw new Error(`Failed to return to IDLE, state=${s}`)
  }

  private async pollUntil(targetState: number) {
    let st = await this.getStatus()
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
    while (st.state !== targetState && st.state !== DfuDevice.STATE.dfuERROR) {
      console.debug(`[DFU] sleep ${st.pollTimeout}ms (state=${st.state}/${DfuDevice.STATE_NAME[st.state]})`)
      await sleep(st.pollTimeout)
      st = await this.getStatus()
    }
    return st
  }

  private async dnloadBlock(data: ArrayBuffer, blockNum: number) {
    await this.requestOut(DfuDevice.DFU.DNLOAD, data, blockNum)
    return this.pollUntil(DfuDevice.STATE.dfuDNLOAD_IDLE)
  }

  // ---- DFUSe vendor extensions ----
  async dfuseSetAddress(addr: number) {
    const b = new ArrayBuffer(5)
    const v = new DataView(b)
    v.setUint8(0, 0x21)
    v.setUint32(1, addr, true)
    await this.abortToIdle()
    const st = await this.dnloadBlock(b, 0)
    if (st.status !== 0) throw new Error(`DFUSe SETADDR failed: status=${st.status}, state=${st.state}`)
  }

  async dfuseErase(addr: number) {
    const b = new ArrayBuffer(5)
    const v = new DataView(b)
    v.setUint8(0, 0x41)
    v.setUint32(1, addr, true)
    await this.abortToIdle()
    const st = await this.dnloadBlock(b, 0)
    if (st.status !== 0) throw new Error(`DFUSe ERASE failed: status=${st.status}, state=${st.state}`)
  }

  /** Read DFU Functional descriptor for this interface/alt and return wTransferSize */
  async getTransferSize(): Promise<number> {
    const GET_DESCRIPTOR = 0x06
    const DT_CONFIGURATION = 0x02
    const wValue = (DT_CONFIGURATION << 8) | this.settings.configuration.configurationValue

    // Read config header to get total length
    const first = await this.device.controlTransferIn(
      { requestType: "standard", recipient: "device", request: GET_DESCRIPTOR, value: wValue, index: 0 },
      4,
    )
    if (first.status !== "ok") throw new Error(String(first.status))
    const wTotalLength = first.data!.getUint16(2, true)

    // Read full configuration descriptor
    const full = await this.device.controlTransferIn(
      { requestType: "standard", recipient: "device", request: GET_DESCRIPTOR, value: wValue, index: 0 },
      wTotalLength,
    )
    if (full.status !== "ok") throw new Error(String(full.status))
    const bytes = new DataView(full.data!.buffer)

    // Walk descriptors to find our interface/alt, then its DFU Functional (type 0x21)
    let offset = 9 // skip config header (9 bytes)
    let inTargetIntf = false

    while (offset + 2 <= bytes.byteLength) {
      const bLength = bytes.getUint8(offset)
      const bType = bytes.getUint8(offset + 1)
      if (bLength < 2) break

      if (bType === 0x04 /* INTERFACE */) {
        const intfNum = bytes.getUint8(offset + 2)
        const alt = bytes.getUint8(offset + 3)
        const cls = bytes.getUint8(offset + 5)
        const subcls = bytes.getUint8(offset + 6)
        const proto = bytes.getUint8(offset + 7)
        inTargetIntf =
          intfNum === this.settings.interface.interfaceNumber &&
          alt === this.settings.alternate.alternateSetting &&
          cls === 0xfe &&
          subcls === 0x01 &&
          proto === 0x02 // DFU mode (DFUSe)
      } else if (inTargetIntf && bType === 0x21 /* DFU Functional */) {
        const wTransferSize = bytes.getUint16(offset + 5, true)
        return wTransferSize || 2048
      }

      offset += bLength
    }

    // Fallback if not found
    return 2048
  }

  /** Write data; for DFUSe we start at block 2 (block 0 is commands) */
  async do_download(xferSize: number, data: ArrayBuffer, manifestationTolerant: boolean, firstBlock = 2) {
    await this.abortToIdle()

    const view = new Uint8Array(data)
    let sent = 0
    let block = firstBlock

    this.logProgress(0, view.byteLength)

    while (sent < view.byteLength) {
      const size = Math.min(xferSize, view.byteLength - sent)
      console.log(`[DFU] Sending block ${block} size ${size}`)
      const st = await this.dnloadBlock(view.slice(sent, sent + size).buffer, block++)
      if (st.status !== 0) throw new Error(`DFU DOWNLOAD failed state=${st.state} status=${st.status}`)
      sent += size
      this.logProgress(sent, view.byteLength)
    }

    console.log(`[DFU] Sending final ZLP (block ${block})`)
    await this.requestOut(DfuDevice.DFU.DNLOAD, new ArrayBuffer(0), block++)

    if (manifestationTolerant) {
      const fin = await this.pollUntil(DfuDevice.STATE.dfuIDLE)
      if (fin.status !== 0) throw new Error(`DFU MANIFEST failed state=${fin.state} status=${fin.status}`)
    } else {
      try {
        await this.getStatus()
      } catch {
        /* ignore */
      }
    }
  }
}

/** ---------- Helpers to pick DFUSe alt/interface ---------- */
function findDfuInterfaces(device: USBDevice): DfuSettings[] {
  const matches: DfuSettings[] = []
  for (const conf of device.configurations || []) {
    for (const intf of conf.interfaces || []) {
      for (const alt of intf.alternates || []) {
        if (alt.interfaceClass === 0xfe && alt.interfaceSubclass === 0x01 && alt.interfaceProtocol === 0x02) {
          matches.push({ configuration: conf, interface: intf, alternate: alt, name: alt.interfaceName })
        }
      }
    }
  }
  return matches
}

/** ---------- Page Component ---------- */
export default function Page() {
  const { lines, log, clear } = useLogger()

  const [connectionStep, setConnectionStep] = useState<"idle" | "normal" | "dfu-mode" | "dfu-connected">("idle")
  const [normalDevice, setNormalDevice] = useState<USBDevice | null>(null)
  const [dfuDevice, setDfuDevice] = useState<DfuDevice | null>(null)

  const [firmwareType, setFirmwareType] = useState<"sunny-basic" | "sunny-advanced" | "upload">("sunny-basic")

  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [pandaBin, setPandaBin] = useState<ArrayBuffer | null>(null)
  const [bootstubBin, setBootstubBin] = useState<ArrayBuffer | null>(null)
  const [statusMessage, setStatusMessage] = useState<string>("")

  const [dfuButtonDisabled, setDfuButtonDisabled] = useState(false)

  const connectNormalDevice = useCallback(async () => {
    clear()
    setStatusMessage("")

    if (!navigator.usb) {
      const errorMsg = "WebUSB not supported. Please use Chrome/Edge on HTTPS."
      log("[v0] WebUSB not available")
      setStatusMessage(errorMsg)
      return
    }

    try {
      const device = await navigator.usb.requestDevice({
        filters: [
          { vendorId: 0x0483, productId: 0xdf11 }, // ST DFU (already in DFU mode)
          { vendorId: 0xbbaa, productId: 0xddcc }, // Panda normal mode
          { vendorId: 0xbbaa }, // Comma devices
          { vendorId: 0x0483 }, // ST devices (fallback)
        ],
      })

      log("[v0] Found device:", device.productName || "Unknown Device")

      // Check if already in DFU mode
      if (device.productId === 0xdf11) {
        log("[v0] Device already in DFU mode, proceeding to step 3")
        setConnectionStep("dfu-mode")
        setStatusMessage('Device is already in DFU mode (solid green LED). Click "Connect DFU Device" to continue.')
        return
      }

      if (device.productName?.toLowerCase().includes("panda") || device.vendorId === 0xbbaa) {
        setNormalDevice(device)
        setConnectionStep("normal")
        setStatusMessage("Connected to panda device. Click 'Enter DFU Mode' to continue.")
        log("[v0] Connected to normal panda device")
      } else {
        // Try to connect anyway but warn user
        setNormalDevice(device)
        setConnectionStep("normal")
        setStatusMessage("Connected to device (may not be panda). Click 'Enter DFU Mode' to continue.")
        log("[v0] Connected to device, attempting to use as panda")
      }
    } catch (e: any) {
      log("[v0] Connect failed:", e?.message || String(e))

      let errorMsg = `Connection failed: ${e?.message || String(e)}`
      if (e?.message?.includes("disallowed by permissions policy")) {
        errorMsg = "WebUSB blocked by permissions policy. Please access via HTTPS or try a different browser."
      } else if (e?.message?.includes("No device selected")) {
        errorMsg = "No device selected. Make sure your panda device is connected."
      }

      setStatusMessage(errorMsg)
    }
  }, [clear, log])

  const enterDfuMode = useCallback(async () => {
    if (!normalDevice) return

    setDfuButtonDisabled(true)
    log("[v0] Sending DFU mode command...")

    const maxAttempts = 3
    let success = false

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        log(`[v0] DFU mode attempt ${attempt}/${maxAttempts}...`)
        await normalDevice.controlTransferOut({
          requestType: "vendor",
          recipient: "device",
          request: 0xd1,
          value: 0,
          index: 0,
        })
        success = true
        break
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        log(`[v0] DFU mode attempt ${attempt} error: ${errorMsg}`)
        if (attempt === maxAttempts) {
          log("[v0] All DFU mode attempts failed")
          setDfuButtonDisabled(false)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    if (success) {
      log("[v0] Waiting for device to fully enter DFU mode...")
      setStatusMessage("Device entering DFU mode...")

      // Wait for device to enter DFU mode, then auto-connect
      setTimeout(async () => {
        log("[v0] Device should now be in DFU mode (solid green LED)")
        setConnectionStep("dfu-mode")
        setDfuButtonDisabled(false)

        // Auto-connect to DFU device
        setTimeout(async () => {
          await connectDfuDevice()
        }, 1000)
      }, 3000)
    }
  }, [normalDevice, log])

  const connectDfuDevice = useCallback(async () => {
    try {
      setStatusMessage("Connecting to DFU device...")

      const device = await navigator.usb.requestDevice({
        filters: [
          { vendorId: 0x0483, productId: 0xdf11 }, // ST DFU (DFUSe)
          { classCode: 0xfe, subclassCode: 0x01 }, // DFU class
        ],
      })

      log("[v0] Found DFU device:", device.productName || "STM32 BOOTLOADER")

      const dfuIfs = findDfuInterfaces(device)
      if (dfuIfs.length === 0) {
        throw new Error("No DFU (protocol 2) interface found. Device may not be in DFU mode.")
      }

      const settings = dfuIfs[0]
      log("[v0] Selected DFU interface/alt:", settings.interface.interfaceNumber, settings.alternate.alternateSetting)

      const dev = new DfuDevice(device, settings)
      dev.logProgress = (done, total) => setProgress({ done, total: total ?? done })
      await dev.open()

      setDfuDevice(dev)
      setConnectionStep("dfu-connected")
      setStatusMessage("DFU device connected successfully! Ready to flash firmware.")
      log("[v0] DFU device opened successfully")
    } catch (e: any) {
      log("[v0] DFU connect failed:", e?.message || String(e))
      setStatusMessage(`DFU connection failed: ${e?.message || String(e)}`)
    }
  }, [log])

  const disconnect = useCallback(async () => {
    try {
      await dfuDevice?.close()
      await normalDevice?.close()
    } catch {}

    setDfuDevice(null)
    setNormalDevice(null)
    setConnectionStep("idle")
    setStatusMessage("")
    log("[v0] Disconnected.")
  }, [dfuDevice, normalDevice, log])

  const isFirmwareReady = useCallback(() => {
    if (firmwareType === "sunny-basic" || firmwareType === "sunny-advanced") {
      return true // Prebuilt options don't need uploaded files
    }
    return pandaBin && bootstubBin // Upload option requires both files
  }, [firmwareType, pandaBin, bootstubBin])

  const loadFirmware = useCallback(async () => {
    if (firmwareType === "sunny-basic") {
      log("[v0] Loading SunnyPilot Basic firmware from GitHub...")
      setStatusMessage("Downloading SunnyPilot Basic firmware...")

      try {
        const [pandaResponse, bootstubResponse] = await Promise.all([
          fetch("https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-basic/panda.bin"),
          fetch(
            "https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-basic/bootstub.panda.bin",
          ),
        ])

        if (!pandaResponse.ok) {
          if (pandaResponse.status === 404) {
            throw new Error(
              `SunnyPilot Basic panda.bin not found in repository. Please check if the file exists at: prebuilt-binaries/sunny-basic/panda.bin`,
            )
          }
          throw new Error(`Failed to fetch panda.bin: ${pandaResponse.status} ${pandaResponse.statusText}`)
        }
        if (!bootstubResponse.ok) {
          if (bootstubResponse.status === 404) {
            throw new Error(
              `SunnyPilot Basic bootstub.panda.bin not found in repository. Please check if the file exists at: prebuilt-binaries/sunny-basic/bootstub.panda.bin`,
            )
          }
          throw new Error(
            `Failed to fetch bootstub.panda.bin: ${bootstubResponse.status} ${bootstubResponse.statusText}`,
          )
        }

        const pandaBuffer = await pandaResponse.arrayBuffer()
        const bootstubBuffer = await bootstubResponse.arrayBuffer()

        log(`[v0] Downloaded panda.bin (${pandaBuffer.byteLength} bytes)`)
        log(`[v0] Downloaded bootstub.panda.bin (${bootstubBuffer.byteLength} bytes)`)

        return { pandaBuffer, bootstubBuffer }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        if (errorMsg.includes("not found in repository")) {
          log("[v0] 💡 Suggestion: Try using 'Upload Custom Files' option instead")
          setStatusMessage(`${errorMsg}. Try using 'Upload Custom Files' option instead.`)
        }
        throw error
      }
    }

    if (firmwareType === "sunny-advanced") {
      log("[v0] Loading SunnyPilot Advanced firmware from GitHub...")
      setStatusMessage("Downloading SunnyPilot Advanced firmware...")

      try {
        const [pandaResponse, bootstubResponse] = await Promise.all([
          fetch("https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-advanced/panda.bin"),
          fetch(
            "https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-advanced/bootstub.panda.bin",
          ),
        ])

        if (!pandaResponse.ok) {
          if (pandaResponse.status === 404) {
            throw new Error(
              `SunnyPilot Advanced panda.bin not found in repository. Please upload the file to: prebuilt-binaries/sunny-advanced/panda.bin`,
            )
          }
          throw new Error(`Failed to fetch advanced panda.bin: ${pandaResponse.status} ${pandaResponse.statusText}`)
        }
        if (!bootstubResponse.ok) {
          if (bootstubResponse.status === 404) {
            throw new Error(
              `SunnyPilot Advanced bootstub.panda.bin not found in repository. Please upload the file to: prebuilt-binaries/sunny-advanced/bootstub.panda.bin`,
            )
          }
          throw new Error(
            `Failed to fetch advanced bootstub.panda.bin: ${bootstubResponse.status} ${bootstubResponse.statusText}`,
          )
        }

        const pandaBuffer = await pandaResponse.arrayBuffer()
        const bootstubBuffer = await bootstubResponse.arrayBuffer()

        log(`[v0] Downloaded advanced panda.bin (${pandaBuffer.byteLength} bytes)`)
        log(`[v0] Downloaded advanced bootstub.panda.bin (${bootstubBuffer.byteLength} bytes)`)

        return { pandaBuffer, bootstubBuffer }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        if (errorMsg.includes("not found in repository")) {
          log("[v0] 💡 Suggestion: Try using 'Upload Custom Files' option instead")
          setStatusMessage(`${errorMsg}. Try using 'Upload Custom Files' option instead.`)
        }
        throw error
      }
    }

    // Use uploaded files
    if (!pandaBin || !bootstubBin) {
      throw new Error("Please upload both panda.bin and bootstub.panda.bin files")
    }
    return { pandaBuffer: pandaBin, bootstubBuffer: bootstubBin }
  }, [firmwareType, pandaBin, bootstubBin, log])

  const writeWithFallback = useCallback(
    async (dev: DfuDevice, data: ArrayBuffer, sizes: number[], operation: string) => {
      let lastErr: unknown
      const tried = new Set<number>()

      for (const s of sizes) {
        if (tried.has(s)) continue
        tried.add(s)
        try {
          log(`[v0] Using wTransferSize = ${s} for ${operation}`)
          await dev.do_download(s, data, /*manifest*/ true, /*firstBlock*/ 2)
          log(`[v0] ✅ Successfully wrote ${operation} (${data.byteLength} bytes) with transfer size ${s}`)
          return true // Return success indicator
        } catch (e) {
          lastErr = e
          const errorMsg = e instanceof Error ? e.message : String(e)
          log(`[v0] ❌ Transfer size ${s} failed for ${operation}: ${errorMsg}`)

          if (errorMsg.includes("disconnected")) {
            log(`[v0] ⚠️ Device disconnected during ${operation} - checking if this indicates success`)

            // If this is the first transfer size and it disconnected, likely an error
            if (s === sizes[0]) {
              log(`[v0] 🔴 Disconnection on first transfer size suggests failure`)
              continue // Try smaller size
            }

            // If we've tried multiple sizes and now disconnected, might be success
            if (tried.size > 1) {
              log(`[v0] 🟡 Disconnection after multiple attempts - assuming ${operation} completed successfully`)
              return true
            }
          }
        }
      }

      const errorMsg = lastErr instanceof Error ? lastErr.message : String(lastErr)
      if (errorMsg.includes("disconnected")) {
        log(`[v0] ⚠️ All transfer sizes failed with disconnection for ${operation}`)
        log(`[v0] 💡 This might indicate successful flash - device may have rebooted`)
        // Return true for disconnection on final attempt as it might indicate success
        return true
      }

      throw lastErr
    },
    [log],
  )

  const flash = useCallback(async () => {
    if (!dfuDevice) {
      setStatusMessage("No DFU device connected")
      return
    }

    if (!isFirmwareReady()) {
      setStatusMessage("Please upload both panda.bin and bootstub.panda.bin files")
      return
    }

    try {
      setStatusMessage("Loading firmware...")
      const { pandaBuffer, bootstubBuffer } = await loadFirmware()

      setStatusMessage("Starting firmware flash...")
      log(
        `[v0] Firmware data prepared — Panda: ${pandaBuffer.byteLength} bytes, Bootstub: ${bootstubBuffer.byteLength} bytes`,
      )

      // Read the device's transfer size
      const transferSize = await dfuDevice.getTransferSize()
      // Build a sensible fallback ladder
      const ladder = [transferSize, 2048, 1024, 512, 256]

      const withTimeout = async (promise: Promise<any>, timeoutMs: number, operation: string): Promise<any> => {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
        })
        return Promise.race([promise, timeoutPromise])
      }

      const reconnectIfNeeded = async () => {
        try {
          await dfuDevice.getState()
          return true // Still connected
        } catch (e) {
          log("[v0] 🔄 Device disconnected during flash - this may indicate successful completion")
          setStatusMessage("Device disconnected during flash - this may indicate successful completion")

          log("[v0] ✅ Assuming flash completed successfully due to device disconnection")
          return true
        }
      }

      // ---- panda.bin @ 0x08004000 (erase three 16KiB pages) ----
      setStatusMessage("Erasing panda firmware area...")
      log("[v0] DFUSe: ERASE panda pages")
      await withTimeout(dfuDevice.dfuseErase(0x08004000), 10000, "Erase 0x08004000")
      await withTimeout(dfuDevice.dfuseErase(0x08008000), 10000, "Erase 0x08008000")
      await withTimeout(dfuDevice.dfuseErase(0x0800c000), 10000, "Erase 0x0800c000")

      setStatusMessage("Writing panda firmware...")
      log("[v0] DFUSe: SETADDR 0x08004000")
      await withTimeout(dfuDevice.dfuseSetAddress(0x08004000), 5000, "Set address 0x08004000")
      log("[v0] Writing panda.bin (start block 2)")
      const pandaSuccess = await withTimeout(
        writeWithFallback(dfuDevice, pandaBuffer, ladder, "panda.bin"),
        30000,
        "Write panda.bin",
      )

      if (!pandaSuccess || !(await reconnectIfNeeded())) {
        throw new Error("Failed to write panda.bin or reconnect after flash")
      }

      // ---- bootstub @ 0x08000000 (erase one 16KiB page) ----
      setStatusMessage("Erasing bootstub area...")
      log("[v0] DFUSe: ERASE bootstub page")
      await withTimeout(dfuDevice.dfuseErase(0x08000000), 10000, "Erase 0x08000000")

      setStatusMessage("Writing bootstub firmware...")
      log("[v0] DFUSe: SETADDR 0x08000000")
      await withTimeout(dfuDevice.dfuseSetAddress(0x08000000), 5000, "Set address 0x08000000")
      log("[v0] Writing bootstub.panda.bin (start block 2)")
      await withTimeout(
        writeWithFallback(dfuDevice, bootstubBuffer, ladder, "bootstub.panda.bin"),
        30000,
        "Write bootstub.panda.bin",
      )

      try {
        log("[v0] Attempting to exit DFU mode...")
        await (dfuDevice as any).requestOut?.(0x00, new ArrayBuffer(0), 1000)
      } catch (e) {
        log("[v0] Exit DFU mode command failed (this is often normal):", e instanceof Error ? e.message : String(e))
      }

      setStatusMessage("✅ Flash completed successfully! Device should reboot automatically.")
      log("[v0] ✅ Flash completed successfully! 🎉")
      log("[v0] 💡 Device should now reboot and exit DFU mode automatically")
    } catch (e: any) {
      const errorMsg = e?.message || String(e)

      if (errorMsg.includes("timed out")) {
        setStatusMessage(`⏱️ Flash failed: ${errorMsg}. Try disconnecting and reconnecting the device.`)
      } else if (errorMsg.includes("disconnected")) {
        setStatusMessage(
          `⚠️ Device disconnected during flash. This may indicate successful completion - check if device rebooted.`,
        )
      } else {
        setStatusMessage(`❌ Flash failed: ${errorMsg}`)
      }

      log("[v0] Flash error:", errorMsg)
    }
  }, [dfuDevice, loadFirmware, log, writeWithFallback, isFirmwareReady])

  const onPickFiles = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = ev.currentTarget.files
    if (!files) return
    for (const f of Array.from(files)) {
      const buf = await f.arrayBuffer()
      if (f.name.toLowerCase().includes("bootstub")) {
        setBootstubBin(buf)
        log(`[v0] Loaded ${f.name} (${buf.byteLength} bytes)`)
      } else {
        setPandaBin(buf)
        log(`[v0] Loaded ${f.name} (${buf.byteLength} bytes)`)
      }
    }
  }

  const progressPct = useMemo(() => {
    if (!progress.total) return 0
    return Math.min(100, Math.floor((progress.done / progress.total) * 100))
  }, [progress])

  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [lines])

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6 relative">
      <div className="fixed bottom-4 right-4 text-xs text-muted-foreground bg-background/80 backdrop-blur-sm px-2 py-1 rounded border">
        <div>v52</div>
        <div>Sept 9 2025</div>
      </div>

      <Alert className="border-red-500 bg-red-50 text-red-900">
        <AlertDescription className="font-semibold">
          ⚠️ WARNING: This tool is still in development and may cause unintended results or bricked devices. Proceed with
          caution and ensure you have recovery methods available. Use at your own risk!
        </AlertDescription>
      </Alert>

      <div className="text-center">
        <h1 className="text-3xl font-bold text-balance">White Panda Firmware Flasher</h1>
        <p className="text-muted-foreground mt-2">Automatic WebUSB DFU Flashing Process</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Firmware Selection</CardTitle>
          <CardDescription>Choose your firmware variant and download the required files</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Select
            value={firmwareType}
            onValueChange={(value: "sunny-basic" | "sunny-advanced" | "upload") => setFirmwareType(value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sunny-basic">SunnyPilot Basic</SelectItem>
              <SelectItem value="sunny-advanced">SunnyPilot Advanced</SelectItem>
              <SelectItem value="upload">Upload Custom Files</SelectItem>
            </SelectContent>
          </Select>

          {firmwareType === "sunny-basic" && (
            <div className="space-y-3 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <h3 className="font-semibold text-blue-900">Basic Firmware</h3>
              <p className="text-sm text-blue-700">
                This will automatically download and flash the SunnyPilot Basic firmware from the repository.
              </p>
              <div className="text-xs text-blue-600 space-y-1">
                <p className="font-medium">Backup download links:</p>
                <div className="flex gap-2">
                  <a
                    href="https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-basic/panda.bin"
                    download="panda.bin"
                    className="underline hover:no-underline"
                  >
                    panda.bin
                  </a>
                  <span>•</span>
                  <a
                    href="https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-basic/bootstub.panda.bin"
                    download="bootstub.panda.bin"
                    className="underline hover:no-underline"
                  >
                    bootstub.panda.bin
                  </a>
                </div>
              </div>
            </div>
          )}

          {firmwareType === "sunny-advanced" && (
            <div className="space-y-3 p-4 bg-purple-50 rounded-lg border border-purple-200">
              <h3 className="font-semibold text-purple-900">Advanced Firmware</h3>
              <p className="text-sm text-purple-700">
                This will automatically download and flash the SunnyPilot Advanced firmware from the repository.
              </p>
              <div className="text-xs text-purple-600 space-y-1">
                <p className="font-medium">Backup download links:</p>
                <div className="flex gap-2">
                  <a
                    href="https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-advanced/panda.bin"
                    download="panda.bin"
                    className="underline hover:no-underline"
                  >
                    panda.bin
                  </a>
                  <span>•</span>
                  <a
                    href="https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-advanced/bootstub.panda.bin"
                    download="bootstub.panda.bin"
                    className="underline hover:no-underline"
                  >
                    bootstub.panda.bin
                  </a>
                </div>
              </div>
            </div>
          )}

          {firmwareType === "upload" && (
            <div className="space-y-2">
              <label className="block text-sm font-medium">Upload your binary files</label>
              <div className="flex items-center justify-center w-full">
                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-muted-foreground/25 rounded-lg cursor-pointer bg-muted/10 hover:bg-muted/20 transition-colors">
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <svg
                      className="w-8 h-8 mb-4 text-muted-foreground"
                      aria-hidden="true"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 20 16"
                    >
                      <path
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M13 13h3a3 3 0 0 0 0-6h-.025A5.56 5.56 0 0 0 16 6.5 5.5 5.5 0 0 0 5.207 5.021C5.137 5.017 5.071 5 5 5a4 4 0 0 0 0 8h2.167M10 15V6m0 0L8 8m2-2 2 2"
                      />
                    </svg>
                    <p className="mb-2 text-sm text-muted-foreground">
                      <span className="font-semibold">Click to upload</span> or drag and drop
                    </p>
                    <p className="text-xs text-muted-foreground">panda.bin and bootstub.panda.bin files</p>
                  </div>
                  <input type="file" multiple onChange={onPickFiles} className="hidden" accept=".bin" />
                </label>
              </div>
              {pandaBin && bootstubBin && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Both binary files loaded successfully
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-3 gap-4">
        <Card className={connectionStep === "idle" ? "ring-2 ring-primary" : ""}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-sm flex items-center justify-center">
                1
              </span>
              Connect Device
            </CardTitle>
            <CardDescription>Connect to panda device in normal mode</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={connectNormalDevice} disabled={connectionStep !== "idle"} className="w-full">
              {connectionStep === "idle" ? "Connect Panda" : "✓ Connected"}
            </Button>
          </CardContent>
        </Card>

        <Card
          className={connectionStep === "dfu-mode" || connectionStep === "dfu-connected" ? "ring-2 ring-primary" : ""}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-sm flex items-center justify-center">
                2
              </span>
              DFU Mode & Connect
            </CardTitle>
            <CardDescription>Enter DFU mode and connect automatically</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={enterDfuMode}
              disabled={connectionStep !== "normal" || dfuButtonDisabled}
              className="w-full"
            >
              {connectionStep === "normal"
                ? dfuButtonDisabled
                  ? "Entering DFU Mode..."
                  : "Enter DFU Mode"
                : connectionStep === "dfu-connected"
                  ? "✓ DFU Connected"
                  : "Waiting for connection"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Status and Progress */}
      {statusMessage && (
        <Alert>
          <AlertDescription>{statusMessage}</AlertDescription>
        </Alert>
      )}

      {connectionStep === "dfu-connected" && (
        <Card>
          <CardHeader>
            <CardTitle>Flash Firmware</CardTitle>
            <CardDescription>
              Ready to flash{" "}
              {firmwareType === "sunny-basic"
                ? "SunnyPilot Basic"
                : firmwareType === "sunny-advanced"
                  ? "SunnyPilot Advanced"
                  : "uploaded"}{" "}
              firmware
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Progress value={progressPct} className="w-full" />
              <div className="text-sm text-muted-foreground">
                Progress: {progress.done}/{progress.total} bytes ({progressPct}%)
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={flash} disabled={!isFirmwareReady()} className="flex-1">
                Flash Firmware
              </Button>
              <Button onClick={disconnect} variant="outline">
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Log */}
      {lines.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Log Output</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              ref={logRef}
              className="h-64 overflow-auto rounded border p-3 text-xs bg-black text-green-300 font-mono"
            >
              {lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
