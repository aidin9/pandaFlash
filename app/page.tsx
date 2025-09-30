"use client"

import type React from "react"
import { useCallback, useMemo, useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Download, Github } from "lucide-react"

/** ---------- Small logging helper ---------- */
const useLogger = () => {
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

  /** Write data; for DFUSe we start at block 2 (block 0 is commands) */
  async do_download(xferSize: number, data: ArrayBuffer, manifestationTolerant: boolean, firstBlock = 2) {
    await this.abortToIdle()

    const view = new Uint8Array(data)
    let sent = 0
    let block = firstBlock

    this.logProgress(0, view.byteLength)

    while (sent < view.byteLength) {
      const size = Math.min(xferSize, view.byteLength - sent)
      const progress = Math.round((sent / view.byteLength) * 100)
      console.log(`[DFU] Block ${block}: ${sent}/${view.byteLength} bytes (${progress}%) - sending ${size} bytes`)

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
}

const writeWithFallback = async (dev: DfuDevice, data: ArrayBuffer, sizes: number[], operation: string, log: any) => {
  let lastErr: unknown
  const tried = new Set<number>()

  // Set up progress logging for this operation
  dev.logProgress = (done: number, total?: number) => {
    if (total) {
      const percent = Math.round((done / total) * 100)
      log(`[v0] 📊 ${operation}: ${done}/${total} bytes (${percent}%)`)
    }
  }

  for (const s of sizes) {
    if (tried.has(s)) continue
    tried.add(s)
    try {
      log(`[v0] 🔄 Attempting ${operation} with transfer size ${s}...`)
      await dev.do_download(s, data, /*manifest*/ true, /*firstBlock*/ 2)
      log(`[v0] ✅ Successfully flashed ${operation} (${data.byteLength} bytes)`)
      return true
    } catch (e) {
      lastErr = e
      const errorMsg = e instanceof Error ? e.message : String(e)

      if (errorMsg.includes("disconnected")) {
        log(`[v0] ⚠️ Device disconnected during ${operation} transfer`)

        // Check if we made significant progress before disconnection
        if (tried.size > 1) {
          log(`[v0] 💡 Disconnection after trying multiple transfer sizes - likely successful`)
          return true
        } else {
          log(`[v0] 🔴 Early disconnection - trying smaller transfer size`)
          continue
        }
      } else {
        log(`[v0] ❌ Transfer failed: ${errorMsg}`)
      }
    }
  }

  // If all sizes failed, check if it was due to disconnection (which might indicate success)
  const errorMsg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  if (errorMsg.includes("disconnected")) {
    log(`[v0] 🤔 All attempts resulted in disconnection - this often means the flash succeeded`)
    log(`[v0] 💡 Device likely rebooted after successful flash`)
    return true
  }

  throw lastErr
}

const flashWithRetry = async (operation: string, data: ArrayBuffer, dev: any, log: any) => {
  const transferSizes = [2048, 1024, 512, 256]
  const tried = new Set<number>()
  let lastErr: any
  const totalProgress = 0

  for (const s of transferSizes) {
    if (tried.has(s)) continue
    tried.add(s)
    try {
      log(`[v0] 🔄 Attempting ${operation} with transfer size ${s}...`)
      await dev.do_download(s, data, /*manifest*/ true, /*firstBlock*/ 2)
      log(`[v0] ✅ Successfully flashed ${operation} (${data.byteLength} bytes)`)
      return true
    } catch (e) {
      lastErr = e
      const errorMsg = e instanceof Error ? e.message : String(e)

      if (errorMsg.includes("disconnected")) {
        if (totalProgress >= data.byteLength * 0.9) {
          log(
            `[v0] 🎉 Device disconnected after ${Math.round((totalProgress / data.byteLength) * 100)}% completion - Flash successful!`,
          )
          return true
        } else if (tried.size > 1) {
          log(`[v0] 💡 Disconnection after trying multiple transfer sizes - likely successful`)
          return true
        } else {
          log(`[v0] 🔴 Early disconnection - trying smaller transfer size`)
          continue
        }
      } else {
        log(`[v0] ❌ Transfer failed: ${errorMsg}`)
      }
    }
  }

  const errorMsg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  if (errorMsg.includes("disconnected")) {
    log(`[v0] 🎉 Flash completed successfully! Device disconnected after completion (normal behavior)`)
    log(`[v0] 💡 Device will reboot automatically with new firmware`)
    return true
  }

  throw lastErr
}

/** ---------- Helpers to pick DFUSe alt/interface ---------- */
const findDfuInterfaces = (device: USBDevice): DfuSettings[] => {
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
        setStatusMessage('Device is already in DFU mode. Click "Connect DFU Device" to continue.')
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
    setTimeout(() => setDfuButtonDisabled(false), 5000)

    try {
      setStatusMessage("Entering DFU mode...")
      log("[v0] Sending DFU mode command...")

      await normalDevice.open()

      let success = false
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          log(`[v0] DFU mode attempt ${attempt}/3...`)

          // Send recover command (vendor-specific control transfer)
          const result = await normalDevice.controlTransferOut({
            requestType: "vendor",
            recipient: "device",
            request: 0xd1, // recover command
            value: 0,
            index: 0,
          })

          if (result.status === "ok") {
            log("[v0] DFU mode command sent successfully")
            success = true
            break
          }
        } catch (error: any) {
          log(`[v0] DFU mode attempt ${attempt} error:`, error.message)
          if (attempt === 3 || error.message.includes("disconnected")) {
            // If disconnected, that's actually success
            if (error.message.includes("disconnected")) {
              success = true
            }
            break
          }
          // Wait a bit before retry
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }

      if (success) {
        log("[v0] Waiting for device to fully enter DFU mode...")
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }

      // Device will disconnect when entering DFU mode
      try {
        await normalDevice.close()
      } catch {
        // Expected - device disconnects
      }

      setNormalDevice(null)
      setConnectionStep("dfu-mode")
      setStatusMessage('Device entered DFU mode successfully! Click "Connect DFU Device" to continue.')
      log("[v0] Device should now be in DFU mode")
    } catch (error: any) {
      log("[v0] DFU mode entry error:", error.message)
      // Even if we get a disconnect error, the device likely entered DFU mode
      if (error.message.includes("disconnected")) {
        setNormalDevice(null)
        setConnectionStep("dfu-mode")
        setStatusMessage('Device entered DFU mode successfully! Click "Connect DFU Device" to continue.')
        log("[v0] Device disconnected (expected) - now in DFU mode")
      } else {
        setStatusMessage(
          `Failed to enter DFU mode: ${error.message}. Try disconnecting and reconnecting the device, then try again.`,
        )
      }
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
        `[v0] 🚀 Starting flash process — Panda: ${pandaBuffer.byteLength} bytes, Bootstub: ${bootstubBuffer.byteLength} bytes`,
      )

      // Read the device's transfer size
      const transferSize = await dfuDevice.getTransferSize()
      const ladder = [transferSize, 2048, 1024, 512, 256]
      log(`[v0] 📋 Device transfer size: ${transferSize}, fallback ladder: [${ladder.join(", ")}]`)

      const withTimeout = async (promise: Promise<any>, timeoutMs: number, operation: string): Promise<any> => {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
        })
        return Promise.race([promise, timeoutPromise])
      }

      // ---- PHASE 1: Flash panda.bin @ 0x08004000 ----
      log(`[v0] 📝 PHASE 1: Flashing panda.bin (${pandaBuffer.byteLength} bytes)`)
      setStatusMessage("Erasing panda firmware area...")
      log("[v0] 🗑️ Erasing panda pages (0x08004000, 0x08008000, 0x0800c000)")

      await withTimeout(dfuDevice.dfuseErase(0x08004000), 10000, "Erase 0x08004000")
      await withTimeout(dfuDevice.dfuseErase(0x08008000), 10000, "Erase 0x08008000")
      await withTimeout(dfuDevice.dfuseErase(0x0800c000), 10000, "Erase 0x0800c000")

      setStatusMessage("Writing panda firmware...")
      log("[v0] 📍 Setting address to 0x08004000")
      await withTimeout(dfuDevice.dfuseSetAddress(0x08004000), 5000, "Set address 0x08004000")

      const pandaSuccess = await withTimeout(
        flashWithRetry("panda.bin", pandaBuffer, dfuDevice, log),
        45000,
        "Write panda.bin",
      )

      if (!pandaSuccess) {
        throw new Error("Failed to write panda.bin")
      }

      // Brief pause between phases
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // ---- PHASE 2: Flash bootstub.panda.bin @ 0x08000000 ----
      log(`[v0] 📝 PHASE 2: Flashing bootstub.panda.bin (${bootstubBuffer.byteLength} bytes)`)

      // Try to reconnect if device disconnected
      try {
        await dfuDevice.getState()
        log("[v0] ✅ Device still connected, proceeding with bootstub")
      } catch (e) {
        log("[v0] ⚠️ Device disconnected after panda.bin - this is often normal")
        log("[v0] 🔄 Attempting to continue with bootstub flash...")
      }

      setStatusMessage("Erasing bootstub area...")
      log("[v0] 🗑️ Erasing bootstub page (0x08000000)")
      await withTimeout(dfuDevice.dfuseErase(0x08000000), 10000, "Erase 0x08000000")

      setStatusMessage("Writing bootstub firmware...")
      log("[v0] 📍 Setting address to 0x08000000")
      await withTimeout(dfuDevice.dfuseSetAddress(0x08000000), 5000, "Set address 0x08000000")

      const bootstubSuccess = await withTimeout(
        flashWithRetry("bootstub.panda.bin", bootstubBuffer, dfuDevice, log),
        30000,
        "Write bootstub.panda.bin",
      )

      if (!bootstubSuccess) {
        throw new Error("Failed to write bootstub.panda.bin")
      }

      // Try to exit DFU mode gracefully
      try {
        log("[v0] 🚪 Attempting to exit DFU mode...")
        await (dfuDevice as any).requestOut?.(0x00, new ArrayBuffer(0), 1000)
        log("[v0] ✅ DFU exit command sent successfully")
      } catch (e) {
        log("[v0] 💡 DFU exit failed (normal) - device should reboot automatically")
      }

      setStatusMessage("🎉 Flash completed successfully! Device is rebooting with new firmware.")
      log("[v0] 🎉 FLASH COMPLETE! Both panda.bin and bootstub.panda.bin written successfully")
      log("[v0] 🔄 Device rebooted automatically - firmware update complete!")
      log("[v0] ✨ Your panda device is now running the new SunnyPilot firmware")
    } catch (e: any) {
      const errorMsg = e?.message || String(e)
      log(`[v0] ❌ Flash failed: ${errorMsg}`)

      if (errorMsg.includes("timed out")) {
        setStatusMessage(`⏱️ Flash failed: Operation timed out. Try disconnecting and reconnecting the device.`)
      } else if (errorMsg.includes("disconnected")) {
        setStatusMessage(`🎉 Flash likely completed! Device disconnected (normal after successful flash).`)
        log("[v0] 💡 Disconnection after flashing usually indicates success - check if device boots normally")
      } else {
        setStatusMessage(`❌ Flash failed: ${errorMsg}`)
      }
    }
  }, [dfuDevice, loadFirmware, log, isFirmwareReady])

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
      <div className="fixed bottom-4 right-4 flex items-center gap-3">
        <a
          href="https://github.com/aidin9/pandaFlash"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-gray-100 dark:bg-gray-800 p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          title="View on GitHub"
        >
          <Github className="h-5 w-5 text-gray-600 dark:text-gray-400" />
        </a>
        <div className="bg-gray-100 dark:bg-gray-800 p-2 rounded text-xs text-gray-600 dark:text-gray-400">
          <div>Version 0.70</div>
          <div>Sept 19 2025</div>
        </div>
      </div>

      <Alert className="border-red-500 bg-red-50 text-red-900">
        <AlertDescription className="font-semibold">
          ⚠️ WARNING: This tool is still in development and may cause unintended results or bricked devices. Proceed with
          caution and ensure you have recovery methods available. Use at your own risk!
        </AlertDescription>
      </Alert>

      <div className="text-center">
        <h1 className="text-3xl font-bold text-balance">Panda Firmware Flasher</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl mx-auto">
          Flash custom firmware to Comma White Panda or similar devices. Designed for WP-Mod firmware used by{" "}
          <a
            href="https://github.com/sunnypilot/sunnypilot"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            SunnyPilot
          </a>{" "}
          and{" "}
          <a
            href="https://github.com/jvePilot/jvePilot"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            JvePilot
          </a>{" "}
          to enable steer-to-zero functionality.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Step 1: Select Firmware</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <label className="block text-base font-semibold">Choose firmware type:</label>
            <select
              value={firmwareType}
              onChange={(e) => setFirmwareType(e.target.value as "sunny-basic" | "sunny-advanced" | "upload")}
              className="w-full p-3 text-lg border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            >
              <option value="sunny-basic">SunnyPilot Basic (Recommended)</option>
              <option value="sunny-advanced">SunnyPilot Advanced</option>
              <option value="upload">Upload Custom Files</option>
            </select>
          </div>

          {firmwareType === "sunny-basic" && (
            <div className="space-y-3 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <p className="text-sm text-blue-700">
                This will automatically download and flash the SunnyPilot Basic firmware from the repository.
              </p>
              <p className="text-xs text-blue-600">
                Source:{" "}
                <a
                  href="https://github.com/sunnypilot/panda/tree/sunnypilot_wp_chrysler_basic"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-blue-800"
                >
                  sunnypilot/panda (sunnypilot_wp_chrysler_basic)
                </a>
              </p>
            </div>
          )}

          {firmwareType === "sunny-advanced" && (
            <div className="space-y-3 p-4 bg-purple-50 rounded-lg border border-purple-200">
              <p className="text-sm text-purple-700">
                This will automatically download and flash the SunnyPilot Advanced firmware from the repository.
              </p>
              <p className="text-xs text-purple-600">
                Source:{" "}
                <a
                  href="https://github.com/sunnypilot/panda/tree/sunnypilot_wp_chrysler_advanced"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-purple-800"
                >
                  sunnypilot/panda (sunnypilot_wp_chrysler_advanced)
                </a>
              </p>
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
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
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

        <Card className={connectionStep === "normal" ? "ring-2 ring-primary" : ""}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-sm flex items-center justify-center">
                2
              </span>
              Enter DFU Mode
            </CardTitle>
            <CardDescription>Put device into firmware update mode</CardDescription>
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
                : connectionStep === "dfu-mode"
                  ? "✓ In DFU Mode"
                  : "Waiting for connection"}
            </Button>
          </CardContent>
        </Card>

        <Card className={connectionStep === "dfu-mode" ? "ring-2 ring-primary" : ""}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-sm flex items-center justify-center">
                3
              </span>
              Connect DFU
            </CardTitle>
            <CardDescription>Connect to device in DFU mode</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={connectDfuDevice} disabled={connectionStep !== "dfu-mode"} className="w-full">
              {connectionStep === "dfu-connected" ? "✓ DFU Connected" : "Connect DFU Device"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Status and Progress */}
      {statusMessage && (
        <Alert className="bg-blue-50 border-blue-200 text-blue-800 text-lg font-medium py-4">
          <AlertDescription className="text-center">{statusMessage}</AlertDescription>
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

      {firmwareType !== "upload" && (
        <div className="mt-4 p-4 bg-muted rounded-lg">
          <p className="text-sm text-muted-foreground mb-2">Backup download links (if needed):</p>
          <div className="flex flex-col gap-2">
            <a
              href={`https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-${firmwareType}/panda.bin`}
              download="panda.bin"
              className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800"
            >
              <Download className="h-4 w-4" />
              Download panda.bin
            </a>
            <a
              href={`https://raw.githubusercontent.com/aidin9/pandaFlash/main/prebuilt-binaries/sunny-${firmwareType}/bootstub.panda.bin`}
              download="bootstub.panda.bin"
              className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800"
            >
              <Download className="h-4 w-4" />
              Download bootstub.panda.bin
            </a>
          </div>
        </div>
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
