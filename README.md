# [Panda Firmware Flasher](https://aidin9.github.io/pandaFlash/)

## 🚀 [**Click Here to Launch**](https://aidin9.github.io/pandaFlash/) 🚀

A web-based tool for flashing custom firmware to Comma White Panda devices using WebUSB and DFU (Device Firmware Update) protocol directly in your browser.

## What is this?

This tool enables you to flash modified firmware to your Comma White Panda or similar devices, specifically designed for the WP-Mod (White Panda Modification) used by [SunnyPilot](https://github.com/sunnyhaibin/sunnypilot) and [JvePilot](https://github.com/jvePilot/openpilot) to enable steer-to-zero functionality.

## Features

- **Browser-based flashing** - No drivers or command-line tools required
- **Prebuilt firmware options** - Direct access to SunnyPilot Basic and Advanced firmware variants
- **Custom firmware upload** - Upload your own compiled `.bin` files
- **Automatic DFU mode** - Seamless transition to DFU mode for flashing
- **Real-time progress** - Live status updates and progress tracking
- **Cross-platform** - Works on Windows, macOS, and Linux with Chrome/Edge browsers

## Requirements

- Chrome or Edge browser (WebUSB support required)
- Comma White Panda device
- USB cable

## How to Use

1. **[Open the app](https://aidin9.github.io/pandaFlash/)**
2. Select your desired firmware (prebuilt or upload custom)
3. Connect your Panda device via USB
4. Click to connect and enter DFU mode
5. Flashing begins automatically once connected
6. Wait for completion and device reconnection

## Technical Details

This tool uses:
- **WebUSB API** for direct browser-to-device communication
- **WebDFU** for Device Firmware Update protocol implementation
- **Next.js** for the web application framework
- **TypeScript** for type-safe code

## Development

To run locally:

\`\`\`bash
npm install
npm run dev
\`\`\`

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Credits

- Firmware sources: [SunnyPilot](https://github.com/sunnyhaibin/sunnypilot) and [JvePilot](https://github.com/jvePilot/openpilot)
- WebDFU implementation based on [devanlai/webdfu](https://github.com/devanlai/webdfu)
- Original Panda firmware: [commaai/panda](https://github.com/commaai/panda)

## License

MIT License - See LICENSE file for details

## Disclaimer

This tool modifies device firmware. Use at your own risk. Always ensure you have a way to recover your device if something goes wrong.
