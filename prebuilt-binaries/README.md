# Prebuilt Firmware Binaries

This folder contains prebuilt firmware binaries for White Panda devices.

## Structure

\`\`\`
prebuilt-binaries/
├── sunny-basic/
│   ├── panda.bin
│   └── bootstub.panda.bin
├── sunny-advanced/          # To be added
│   ├── panda.bin
│   └── bootstub.panda.bin
└── README.md
\`\`\`

## SunnyPilot Basic

The `sunny-basic` folder contains binaries built from:
- Repository: https://github.com/sunnyhaibin/panda
- Branch: sunnypilot_wp_chrysler_basic

## Adding Advanced Firmware

To add SunnyPilot Advanced firmware:
1. Build from branch `sunnypilot_wp_chrysler_advanced`
2. Copy `obj/panda.bin` and `obj/bootstub.panda.bin` to `sunny-advanced/` folder
3. Update the web app to include the advanced option

## Build Instructions

To build these binaries yourself:

\`\`\`bash
git clone https://github.com/sunnyhaibin/panda.git
cd panda
git checkout sunnypilot_wp_chrysler_basic  # or sunnypilot_wp_chrysler_advanced
cd board
./get_sdk.sh
make recover
# Binaries will be in obj/ folder
\`\`\`

## Usage

The web flasher automatically loads these prebuilt binaries when "SunnyPilot Basic" is selected. For manual flashing, use the "Upload Binary Files" option to select your own binaries.
