"use client"

import { CardDescription } from "@/components/ui/card"

import type React from "react"
import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import { Zap, Usb, Copy, CheckCircle, AlertTriangle, Download, Terminal } from "lucide-react"

interface DFUDevice {
  open(): Promise<void>
  close(): Promise<void>
  do_download(xferSize: number, data: ArrayBuffer, manifestationTolerant: boolean): Promise<void>
  logProgress: (done: number, total?: number) => void
}

interface WebDFU {
  findDeviceDfuInterfaces(device: USBDevice): any[]
  Device: new (device: USBDevice, settings: any) => DFUDevice
}

declare global {
  interface Window {
    dfu?: WebDFU
  }
}

type FlashStatus = "idle" | "ready" | "connecting" | "flashing" | "complete" | "error"
type FirmwareSource = "upload" | "preset" | "url"
type ConnectionStatus = "disconnected" | "normal" | "dfu"

const PRESET_FIRMWARES = [
  {
    id: "sunny-basic",
    name: "SunnyPilot Basic",
    description: "Basic White Panda firmware by SunnyHaibin",
    pandaUrl: "https://1drv.ms/u/c/153c6473912eb8ca/EWFnkdJ_LiNIjqDuOEw5DBkBUUWmQujwb48yCo4q03WebQ?e=KkyMgO",
    bootstubUrl: "https://1drv.ms/u/c/153c6473912eb8ca/EX_rCtkqvm5Lk-rH0KtS33YB5Y1FyRZ5dgldp81ufIkm7w?e=gBN5LC",
  },
  {
    id: "upload",
    name: "Upload Binary Files",
    description: "Upload your own panda.bin and bootstub.panda.bin files",
    pandaUrl: "",
    bootstubUrl: "",
  },
]

export default function PandaFlasher() {
  const [selectedPreset, setSelectedPreset] = useState("sunny-basic")
  const [customUrl, setCustomUrl] = useState("")
  const [pandaBin, setPandaBin] = useState<File | null>(null)
  const [bootstubBin, setBootstubBin] = useState<File | null>(null)
  const [flashStatus, setFlashStatus] = useState<FlashStatus>("idle")
  const [statusMessage, setStatusMessage] = useState("")
  const [commands, setCommands] = useState<string[]>([])
  const [progress, setProgress] = useState(0)
  const [connectedDevice, setConnectedDevice] = useState<DFUDevice | null>(null)
  const [dfuSupported, setDfuSupported] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected")
  const [normalDevice, setNormalDevice] = useState<USBDevice | null>(null)

  useEffect(() => {
    const loadWebDFU = async () => {
      try {
        // Check if WebUSB is supported
        if (!("usb" in navigator)) {
          console.log("WebUSB not supported")
          return
        }

        // Define WebDFU functionality inline to avoid loading issues
        const webDFU = {
          findDeviceDfuInterfaces: (device: USBDevice) => {
            return (
              device.configurations?.[0]?.interfaces?.filter((intf) => intf.alternates?.[0]?.interfaceClass === 0xfe) ||
              []
            )
          },
          Device: class {
            device: USBDevice
            settings: any
            logProgress: (done: number, total?: number) => void = () => {}

            constructor(device: USBDevice, settings: any) {
              this.device = device
              this.settings = settings
            }

            async open() {
              if (!this.device.opened) {
                await this.device.open()
              }
              await this.device.selectConfiguration(1)
              const interfaceNumber = this.settings.interface.interfaceNumber
              console.log("[v0] Claiming interface:", interfaceNumber)
              await this.device.claimInterface(interfaceNumber)

              await this.device.selectAlternateInterface(interfaceNumber, this.settings.interface.alternateSetting || 0)
            }

            async close() {
              if (this.device.opened) {
                await this.device.close()
              }
            }

            async do_download(xferSize: number, data: ArrayBuffer, manifestationTolerant: boolean) {
              console.log("[v0] Starting DFU download with", data.byteLength, "bytes")
              const dataView = new Uint8Array(data)
              let bytesTransferred = 0

              // DFU protocol constants
              const DFU_DNLOAD = 1
              const DFU_GETSTATUS = 3
              const DFU_CLRSTATUS = 4

              try {
                // Clear any previous DFU status
                await this.device.controlTransferOut({
                  requestType: "class",
                  recipient: "interface",
                  request: DFU_CLRSTATUS,
                  value: 0,
                  index: this.settings.interface.interfaceNumber,
                })

                // Send data in chunks using DFU_DNLOAD control transfers
                let blockNum = 0
                while (bytesTransferred < data.byteLength) {
                  const chunkSize = Math.min(xferSize, data.byteLength - bytesTransferred)
                  const chunk = dataView.slice(bytesTransferred, bytesTransferred + chunkSize)

                  console.log("[v0] Sending block", blockNum, "size", chunkSize, "bytes")

                  // Send DFU_DNLOAD command with data
                  await this.device.controlTransferOut(
                    {
                      requestType: "class",
                      recipient: "interface",
                      request: DFU_DNLOAD,
                      value: blockNum,
                      index: this.settings.interface.interfaceNumber,
                    },
                    chunk,
                  )

                  // Check DFU status after each block
                  const statusResult = await this.device.controlTransferIn(
                    {
                      requestType: "class",
                      recipient: "interface",
                      request: DFU_GETSTATUS,
                      value: 0,
                      index: this.settings.interface.interfaceNumber,
                    },
                    6,
                  )

                  if (statusResult.data && statusResult.data.byteLength >= 1) {
                    const status = new Uint8Array(statusResult.data.buffer)
                    const dfuStatus = status[0]
                    console.log("[v0] DFU status:", dfuStatus)
                    if (dfuStatus !== 0) {
                      throw new Error(`DFU error status: ${dfuStatus}`)
                    }
                  } else {
                    console.log("[v0] No status data received, continuing...")
                  }

                  bytesTransferred += chunkSize
                  blockNum++

                  this.logProgress(bytesTransferred, data.byteLength)

                  // Small delay between blocks
                  await new Promise((resolve) => setTimeout(resolve, 10))
                }

                // Send zero-length DFU_DNLOAD to signal end of transfer
                console.log("[v0] Sending final zero-length block")
                await this.device.controlTransferOut({
                  requestType: "class",
                  recipient: "interface",
                  request: DFU_DNLOAD,
                  value: blockNum,
                  index: this.settings.interface.interfaceNumber,
                })

                console.log("[v0] DFU download completed successfully")
              } catch (error) {
                console.error("[v0] DFU download error:", error)
                throw error
              }
            }
          },
        }

        // Make it available globally
        window.dfu = webDFU as WebDFU
        setDfuSupported(true)
        console.log("WebDFU functionality loaded successfully")
      } catch (error) {
        console.log("Failed to load WebDFU:", error)
        setDfuSupported(false)
      }
    }

    loadWebDFU()
  }, [])

  const connectNormalDevice = async () => {
    if (!navigator.usb) {
      setStatusMessage("WebUSB not supported in this browser")
      setFlashStatus("error")
      return
    }

    try {
      setFlashStatus("connecting")
      setStatusMessage("Looking for panda device...")

      const device = await navigator.usb.requestDevice({
        filters: [
          { vendorId: 0x0483 }, // STM32 vendor ID
          { productName: "panda" }, // Look for devices named "panda"
        ],
      })

      console.log("[v0] Found device:", device)
      setNormalDevice(device)
      setConnectionStatus("normal")
      setFlashStatus("ready")
      setStatusMessage("Panda device found! Click 'Enter DFU Mode' to prepare for flashing.")
    } catch (error: any) {
      console.error("Connection error:", error)
      setFlashStatus("error")
      setStatusMessage(
        `Connection failed: ${error.message}. Make sure your White Panda is connected and not in DFU mode.`,
      )
    }
  }

  const enterDfuMode = async () => {
    if (!normalDevice) {
      setStatusMessage("No normal device connected")
      return
    }

    try {
      setFlashStatus("connecting")
      setStatusMessage("Putting device into DFU mode...")

      await normalDevice.open()
      await normalDevice.selectConfiguration(1)
      await normalDevice.claimInterface(0)

      // Send the recover command that puts the panda into DFU mode
      // This mimics what the panda.recover() method does
      const recoverCommand = new Uint8Array([0xd1]) // Panda recover command

      try {
        // Send control transfer to trigger recovery/DFU mode
        await normalDevice.controlTransferOut(
          {
            requestType: "vendor",
            recipient: "device",
            request: 0xd1, // Recover request
            value: 0,
            index: 0,
          },
          recoverCommand,
        )

        console.log("[v0] Recover command sent successfully")
      } catch (transferError) {
        console.log("[v0] Recover command sent, device disconnecting (expected):", transferError)
      }

      try {
        await normalDevice.close()
      } catch (closeError) {
        console.log("[v0] Device already disconnected during close (expected):", closeError)
      }

      setNormalDevice(null)
      setConnectionStatus("disconnected")
      setFlashStatus("idle")
      setStatusMessage(
        "Device entered DFU mode successfully! LED should be solid green. Click 'Connect DFU Device' to continue.",
      )
    } catch (error: any) {
      console.log("[v0] DFU mode entry error (likely expected disconnect):", error)

      try {
        if (normalDevice) {
          await normalDevice.close()
        }
      } catch (closeError) {
        console.log("[v0] Error closing device (expected):", closeError)
      }

      setNormalDevice(null)
      setConnectionStatus("disconnected")
      setFlashStatus("idle")
      setStatusMessage(
        "Device entered DFU mode successfully! LED should be solid green. Click 'Connect DFU Device' to continue.",
      )
    }
  }

  const connectDevice = async () => {
    try {
      setConnectionStatus("connecting")
      setStatusMessage("Requesting DFU device access...")

      const device = await navigator.usb.requestDevice({
        filters: [{ vendorId: 0x0483, productId: 0xdf11 }],
      })

      console.log("[v0] Selected DFU device:", device)
      console.log("[v0] Device configurations:", device.configurations)

      await device.open()
      console.log("[v0] Device opened successfully")

      const interfaces = window.dfu.findDeviceDfuInterfaces(device)
      console.log("[v0] Found DFU interfaces:", interfaces)
      console.log(
        "[v0] Interface details:",
        interfaces.map((intf) => ({
          interface: intf,
          alternates: intf.alternates,
          interfaceNumber: intf.interfaceNumber,
        })),
      )

      if (interfaces.length === 0) {
        throw new Error("No DFU interfaces found")
      }

      const dfuInterface = interfaces[0]
      console.log("[v0] Selected DFU interface:", dfuInterface)

      if (!dfuInterface.alternates || dfuInterface.alternates.length === 0) {
        throw new Error("DFU interface has no alternates")
      }

      const alternate = dfuInterface.alternates[0]
      console.log("[v0] Selected alternate:", alternate)
      console.log("[v0] Interface number from interface:", dfuInterface.interfaceNumber)

      // Use interfaceNumber from the interface object, not the alternate
      const interfaceNumber = dfuInterface.interfaceNumber
      if (interfaceNumber === undefined) {
        console.error("[v0] Invalid interface structure:", dfuInterface)
        throw new Error(`Invalid DFU interface structure - interfaceNumber: ${interfaceNumber}`)
      }

      await device.claimInterface(interfaceNumber)
      console.log("[v0] Claimed interface:", interfaceNumber)

      // Create settings object with correct structure
      const settings = {
        interface: {
          interfaceNumber: interfaceNumber,
          alternateSetting: alternate.alternateSetting || 0,
        },
      }
      console.log("[v0] Creating DFU device with settings:", settings)

      const dfuDevice = new window.dfu.Device(device, settings)
      console.log("[v0] DFU device created:", dfuDevice)

      setConnectedDevice(dfuDevice)
      setConnectionStatus("dfu")
      setStatusMessage("DFU device connected successfully! Ready to flash firmware.")
    } catch (error: any) {
      console.error("[v0] DFU connection error:", error)
      setConnectionStatus("disconnected")
      setStatusMessage(`Connection failed: ${error.message}`)
    }
  }

  const flashFirmware = async () => {
    if (!connectedDevice) {
      setStatusMessage("Please connect to DFU device first")
      return
    }

    try {
      setFlashStatus("flashing")
      setStatusMessage("Loading firmware...")

      let pandaData: ArrayBuffer
      let bootstubData: ArrayBuffer

      if (selectedPreset === "upload") {
        if (!pandaBin || !bootstubBin) {
          throw new Error("Both binary files are required")
        }
        console.log("[v0] Using uploaded files:", pandaBin.name, bootstubBin.name)
        pandaData = await pandaBin.arrayBuffer()
        bootstubData = await bootstubBin.arrayBuffer()
      } else {
        const preset = PRESET_FIRMWARES.find((f) => f.id === selectedPreset)
        if (!preset) throw new Error("Invalid preset selected")

        if (!preset.pandaUrl || !preset.bootstubUrl) {
          throw new Error("This preset firmware is not yet available. Please use the upload option.")
        }

        setStatusMessage("Loading firmware files...")
        console.log("[v0] Loading firmware from preset URLs:", preset.pandaUrl, preset.bootstubUrl)

        try {
          console.log("[v0] Fetching panda.bin...")
          const pandaResponse = await Promise.race([
            fetch(preset.pandaUrl),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Fetch timeout after 10 seconds")), 10000),
            ),
          ])

          console.log("[v0] Fetching bootstub.panda.bin...")
          const bootstubResponse = await Promise.race([
            fetch(preset.bootstubUrl),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Fetch timeout after 10 seconds")), 10000),
            ),
          ])

          console.log("[v0] Fetch responses:", pandaResponse.status, bootstubResponse.status)

          if (!pandaResponse.ok) {
            throw new Error(
              `Failed to load panda.bin (HTTP ${pandaResponse.status}). The preset firmware URLs may not be accessible. Please try the upload option instead.`,
            )
          }

          if (!bootstubResponse.ok) {
            throw new Error(
              `Failed to load bootstub.panda.bin (HTTP ${bootstubResponse.status}). The preset firmware URLs may not be accessible. Please try the upload option instead.`,
            )
          }

          pandaData = await pandaResponse.arrayBuffer()
          bootstubData = await bootstubResponse.arrayBuffer()

          console.log("[v0] Loaded firmware sizes:", pandaData.byteLength, bootstubData.byteLength)

          if (pandaData.byteLength === 0) {
            throw new Error("Panda firmware file is empty")
          }
          if (bootstubData.byteLength === 0) {
            throw new Error("Bootstub firmware file is empty")
          }
        } catch (fetchError: any) {
          console.error("[v0] Firmware loading failed:", fetchError)
          throw new Error(`Firmware loading failed: ${fetchError.message}`)
        }
      }

      console.log(
        "[v0] Firmware data prepared - Panda:",
        pandaData.byteLength,
        "bytes, Bootstub:",
        bootstubData.byteLength,
        "bytes",
      )

      setStatusMessage("Flashing main firmware (panda.bin) - this may take up to 30 seconds...")
      setProgress(10)
      console.log("[v0] Starting panda.bin flash to address 0x08004000")

      // Set up progress callback for panda.bin (10-60%)
      const originalLogProgress = connectedDevice.logProgress
      connectedDevice.logProgress = (done: number, total?: number) => {
        console.log("[v0] Panda flash progress:", done, "/", total, "bytes")
        if (total) {
          const percent = Math.round((done / total) * 50) + 10 // 10-60% for panda
          setProgress(percent)
          setStatusMessage(`Flashing panda.bin: ${Math.round((done / total) * 100)}% (${done}/${total} bytes)`)
        }
      }

      try {
        console.log("[v0] Calling do_download for panda.bin with 30s timeout")
        await Promise.race([
          connectedDevice.do_download(2048, pandaData, false),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Panda.bin flash timeout after 30 seconds")), 30000),
          ),
        ])
        console.log("[v0] Panda.bin flash completed successfully")
      } catch (pandaError) {
        console.error("[v0] Panda.bin flash failed:", pandaError)
        throw new Error(`Failed to flash panda.bin: ${pandaError}`)
      }

      setProgress(60)
      setStatusMessage("Flashing bootloader (bootstub.panda.bin) - this may take up to 30 seconds...")
      console.log("[v0] Starting bootstub.panda.bin flash to address 0x08000000")

      connectedDevice.logProgress = (done: number, total?: number) => {
        console.log("[v0] Bootstub flash progress:", done, "/", total, "bytes")
        if (total) {
          const percent = Math.round((done / total) * 35) + 60 // 60-95% for bootstub
          setProgress(percent)
          setStatusMessage(`Flashing bootstub.panda.bin: ${Math.round((done / total) * 100)}% (${done}/${total} bytes)`)
        }
      }

      try {
        console.log("[v0] Calling do_download for bootstub.panda.bin with 30s timeout")
        await Promise.race([
          connectedDevice.do_download(2048, bootstubData, true),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Bootstub.panda.bin flash timeout after 30 seconds")), 30000),
          ),
        ])
        console.log("[v0] Bootstub.panda.bin flash completed successfully")
      } catch (bootstubError) {
        console.error("[v0] Bootstub.panda.bin flash failed:", bootstubError)
        throw new Error(`Failed to flash bootstub.panda.bin: ${bootstubError}`)
      }

      // Restore original progress function
      connectedDevice.logProgress = originalLogProgress

      setProgress(100)
      setFlashStatus("complete")
      setStatusMessage("Firmware flashed successfully! Device should restart automatically.")
      console.log("[v0] Firmware flash process completed successfully")
    } catch (error: any) {
      console.error("[v0] Flash error details:", error)
      console.error("[v0] Error stack:", error.stack)
      setFlashStatus("error")
      setStatusMessage(`Flash failed: ${error.message}`)
      setProgress(0)

      if (error.message.includes("timeout")) {
        setStatusMessage(
          `Flash failed: ${error.message}. The device may not be responding properly. Try disconnecting and reconnecting the device, then try again.`,
        )
      } else if (error.message.includes("do_download")) {
        setStatusMessage(
          `Flash failed: ${error.message}. This might be due to WebDFU limitations. Try using the manual commands instead.`,
        )
      }
    }
  }

  const handlePandaBinUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file && file.name.endsWith(".bin")) {
      setPandaBin(file)
      updateCommands(file, bootstubBin)
    }
  }

  const handleBootstubBinUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file && file.name.endsWith(".bin")) {
      setBootstubBin(file)
      updateCommands(pandaBin, file)
    }
  }

  const updateCommands = (panda: File | null, bootstub: File | null) => {
    const newCommands: string[] = []

    if (panda) {
      newCommands.push(`sudo dfu-util -d 0483:df11 -a 0 -s 0x08004000 -D ${panda.name}`)
    }

    if (bootstub) {
      newCommands.push(`sudo dfu-util -d 0483:df11 -a 0 -s 0x08000000:leave -D ${bootstub.name}`)
    }

    setCommands(newCommands)

    if (panda && bootstub) {
      setFlashStatus("ready")
      setStatusMessage("Both binaries uploaded. Ready to flash!")
    } else if (panda || bootstub) {
      setFlashStatus("idle")
      setStatusMessage("Upload both panda.bin and bootstub.panda.bin files")
    } else {
      setFlashStatus("idle")
      setStatusMessage("")
    }
  }

  const copyCommand = (command: string) => {
    navigator.clipboard.writeText(command)
    setStatusMessage("Command copied to clipboard!")
    setTimeout(() => {
      if (pandaBin && bootstubBin) {
        setStatusMessage("Both binaries uploaded. Ready to flash!")
      }
    }, 2000)
  }

  const copyAllCommands = () => {
    const allCommands = commands.join("\n")
    navigator.clipboard.writeText(allCommands)
    setStatusMessage("All commands copied to clipboard!")
    setTimeout(() => {
      if (pandaBin && bootstubBin) {
        setStatusMessage("Both binaries uploaded. Ready to flash!")
      }
    }, 2000)
  }

  const reset = () => {
    setPandaBin(null)
    setBootstubBin(null)
    setSelectedPreset("")
    setCustomUrl("")
    setFlashStatus("idle")
    setStatusMessage("")
    setCommands([])
    setProgress(0)
    if (connectedDevice) {
      connectedDevice.close()
      setConnectedDevice(null)
    }
    setConnectionStatus("disconnected")
    setNormalDevice(null)
  }

  const generateManualCommands = () => {
    const userAgent = navigator.userAgent
    const isMac = userAgent.includes("Mac")
    const sudoPrefix = isMac ? "sudo " : "sudo "
    const installInstructions = isMac ? "brew install dfu-util" : "sudo apt-get install dfu-util"

    return {
      install: installInstructions,
      flash1: `${sudoPrefix}dfu-util -d 0483:df11 -a 0 -s 0x08004000 -D panda.bin`,
      flash2: `${sudoPrefix}dfu-util -d 0483:df11 -a 0 -s 0x08000000:leave -D bootstub.panda.bin`,
      note: isMac
        ? "Note: On macOS, you may need to install dfu-util using Homebrew first."
        : "Note: Make sure dfu-util is installed on your system.",
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="border-red-500 bg-red-50">
          <CardContent className="p-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-red-600 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="text-lg font-semibold text-red-800 mb-2">
                  ⚠️ DEVELOPMENT SOFTWARE - USE AT YOUR OWN RISK
                </h3>
                <p className="text-red-700 text-sm leading-relaxed">
                  This firmware flasher is still in active development and may cause unintended results or permanently
                  brick your White Panda device. Flashing firmware can render your device unusable if something goes
                  wrong. Only proceed if you understand the risks and have experience with firmware recovery procedures.
                  The developers are not responsible for any damage to your device.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {dfuSupported && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Usb className="h-5 w-5" />
                Device Connection
              </CardTitle>
              <CardDescription>Connect your White Panda device via WebUSB for direct flashing</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {connectionStatus === "disconnected" && (
                <div className="space-y-3">
                  <Button onClick={connectNormalDevice} disabled={flashStatus === "connecting"} className="w-full">
                    <Usb className="h-4 w-4 mr-2" />
                    {flashStatus === "connecting" ? "Looking for device..." : "1. Connect Panda Device"}
                  </Button>
                  <p className="text-sm text-muted-foreground text-center">
                    First, connect to your White Panda in normal mode (should appear as "panda")
                  </p>
                </div>
              )}

              {connectionStatus === "normal" && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-green-600 mb-2">
                    <CheckCircle className="h-4 w-4" />
                    Panda device connected in normal mode
                  </div>
                  <Button onClick={enterDfuMode} disabled={flashStatus === "connecting"} className="w-full">
                    <Zap className="h-4 w-4 mr-2" />
                    {flashStatus === "connecting" ? "Entering DFU mode..." : "2. Enter DFU Mode"}
                  </Button>
                  <p className="text-sm text-muted-foreground text-center">
                    Put the device into firmware update mode (LED should turn solid green instead of rainbow colors)
                  </p>
                </div>
              )}

              {connectionStatus === "disconnected" &&
                normalDevice === null &&
                flashStatus === "idle" &&
                statusMessage.includes("DFU mode") && (
                  <div className="space-y-3">
                    <Button onClick={connectDevice} disabled={flashStatus === "connecting"} className="w-full">
                      <Usb className="h-4 w-4 mr-2" />
                      {flashStatus === "connecting" ? "Connecting..." : "3. Connect DFU Device"}
                    </Button>
                    <p className="text-sm text-muted-foreground text-center">
                      Connect to the device in DFU mode for flashing
                    </p>
                  </div>
                )}

              {connectionStatus === "dfu" && connectedDevice && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle className="h-4 w-4" />
                  Device connected in DFU mode and ready for flashing
                </div>
              )}

              {statusMessage && (
                <Alert className={flashStatus === "error" ? "border-red-500" : ""}>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{statusMessage}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="h-5 w-5" />
              Firmware Selection
            </CardTitle>
            <CardDescription>Choose your firmware source</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <Label>Select Firmware</Label>
              <Select value={selectedPreset} onValueChange={setSelectedPreset}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose firmware or upload option" />
                </SelectTrigger>
                <SelectContent>
                  {PRESET_FIRMWARES.map((firmware) => (
                    <SelectItem key={firmware.id} value={firmware.id}>
                      {firmware.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedPreset && (
                <div className="text-sm text-muted-foreground">
                  {PRESET_FIRMWARES.find((f) => f.id === selectedPreset)?.description}
                </div>
              )}
            </div>

            {selectedPreset === "upload" && (
              <div className="space-y-6">
                {/* Panda Binary */}
                <div className="space-y-2">
                  <Label htmlFor="panda-bin">Main Firmware (panda.bin)</Label>
                  <Input id="panda-bin" type="file" accept=".bin" onChange={handlePandaBinUpload} />
                  {pandaBin && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle className="h-4 w-4 text-green-500" />
                      {pandaBin.name} ({(pandaBin.size / 1024).toFixed(1)} KB)
                    </div>
                  )}
                </div>

                {/* Bootstub Binary */}
                <div className="space-y-2">
                  <Label htmlFor="bootstub-bin">Bootloader (bootstub.panda.bin)</Label>
                  <Input id="bootstub-bin" type="file" accept=".bin" onChange={handleBootstubBinUpload} />
                  {bootstubBin && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle className="h-4 w-4 text-green-500" />
                      {bootstubBin.name} ({(bootstubBin.size / 1024).toFixed(1)} KB)
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {dfuSupported && connectedDevice && connectionStatus === "dfu" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Flash Firmware
              </CardTitle>
              <CardDescription>Flash firmware directly to your White Panda device</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {flashStatus === "flashing" && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Progress</span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
              )}

              <Button
                onClick={flashFirmware}
                disabled={flashStatus === "flashing" || !connectedDevice}
                className="w-full"
              >
                <Zap className="h-4 w-4 mr-2" />
                {flashStatus === "flashing" ? "Flashing..." : "Flash Firmware"}
              </Button>

              {statusMessage && flashStatus !== "error" && (
                <Alert className={flashStatus === "complete" ? "border-green-500" : ""}>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{statusMessage}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        {(!dfuSupported || !connectedDevice) && commands.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="h-5 w-5" />
                Manual Flash Commands
              </CardTitle>
              <CardDescription>Run these commands in your terminal if direct flashing is not available</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {commands.map((command, index) => (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">
                        Step {index + 1}: {index === 0 ? "Flash main firmware" : "Flash bootloader"}
                      </Label>
                      <Button variant="outline" size="sm" onClick={() => copyCommand(command)} className="h-8">
                        <Copy className="h-3 w-3 mr-1" />
                        Copy
                      </Button>
                    </div>
                    <div className="bg-muted p-3 rounded-md font-mono text-sm">{command}</div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <Button onClick={copyAllCommands} className="flex-1">
                  <Copy className="h-4 w-4 mr-2" />
                  Copy All Commands
                </Button>
                <Button onClick={reset} variant="outline">
                  Reset
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {connectionStatus === "error" && (
          <div className="space-y-4">
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <h3 className="font-semibold text-red-800 mb-2">Manual Terminal Commands</h3>
              <p className="text-sm text-red-700 mb-3">{generateManualCommands().note}</p>
              <div className="space-y-2 font-mono text-sm">
                <div>
                  <span className="text-gray-600">Install dfu-util:</span>
                  <br />
                  <code className="bg-gray-100 px-2 py-1 rounded">{generateManualCommands().install}</code>
                </div>
                <div>
                  <span className="text-gray-600">Flash panda.bin:</span>
                  <br />
                  <code className="bg-gray-100 px-2 py-1 rounded">{generateManualCommands().flash1}</code>
                </div>
                <div>
                  <span className="text-gray-600">Flash bootstub:</span>
                  <br />
                  <code className="bg-gray-100 px-2 py-1 rounded">{generateManualCommands().flash2}</code>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Instructions */}
        <Card className="border-emerald-200 shadow-lg">
          <CardHeader className="bg-gradient-to-r from-emerald-50 to-teal-50 border-b border-emerald-100">
            <CardTitle className="text-2xl font-bold text-emerald-800 flex items-center gap-3">
              <Zap className="h-8 w-8 text-emerald-600" />
              White Panda Firmware Flasher
            </CardTitle>
            <p className="text-emerald-700 mt-2">
              Flash firmware to your Comma White Panda device using WebUSB technology
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3 text-sm">
              {dfuSupported ? (
                <>
                  <div className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold">
                      1
                    </span>
                    <div>
                      <p className="font-medium">Connect in normal mode</p>
                      <p className="text-muted-foreground">
                        Connect your White Panda in normal mode - it should appear as "panda" in the device list
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold">
                      2
                    </span>
                    <div>
                      <p className="font-medium">Enter DFU mode</p>
                      <p className="text-muted-foreground">
                        Click "Enter DFU Mode" to put the device into firmware update mode
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold">
                      3
                    </span>
                    <div>
                      <p className="font-medium">Connect DFU device</p>
                      <p className="text-muted-foreground">
                        After the device resets, connect to it in DFU mode for flashing
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold">
                      4
                    </span>
                    <div>
                      <p className="font-medium">Select firmware and flash</p>
                      <p className="text-muted-foreground">
                        Choose your firmware source, then click "Flash Firmware" to update your device directly
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold">
                      1
                    </span>
                    <div>
                      <p className="font-medium">Get the binary files</p>
                      <p className="text-muted-foreground">
                        Download pre-built binaries from{" "}
                        <a
                          href="https://github.com/sunnyhaibin/panda/releases/latest"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline"
                        >
                          SunnyHaibin's releases
                        </a>{" "}
                        or build them yourself from source
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold">
                      2
                    </span>
                    <div>
                      <p className="font-medium">Install dfu-util</p>
                      <p className="text-muted-foreground">
                        macOS: <code className="bg-muted px-1 rounded">brew install dfu-util</code>
                        <br />
                        Ubuntu/Debian: <code className="bg-muted px-1 rounded">sudo apt install dfu-util</code>
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold">
                      3
                    </span>
                    <div>
                      <p className="font-medium">Put device in DFU mode</p>
                      <p className="text-muted-foreground">
                        Connect your White Panda and put it in DFU (Device Firmware Update) mode
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold">
                      4
                    </span>
                    <div>
                      <p className="font-medium">Upload binaries and run commands</p>
                      <p className="text-muted-foreground">
                        Upload both binary files above, then copy and run the generated commands in your terminal
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>

            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>Important:</strong>{" "}
                {dfuSupported
                  ? "Follow the connection steps in order. The device will appear as 'panda' first, then switch to DFU mode for flashing. In DFU mode, the LED should be solid green instead of rainbow colors."
                  : "Make sure your White Panda is in DFU mode before flashing. The device should show up when you run lsusb with vendor ID 0483 and product ID df11."}
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <div className="flex justify-center">
          <Button onClick={reset} variant="outline">
            Reset All
          </Button>
        </div>
      </div>
    </div>
  )
}
