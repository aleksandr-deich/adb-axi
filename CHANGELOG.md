# Changelog

## [0.2.0](https://github.com/aleksandr-deich/adb-axi/compare/v0.1.3...v0.2.0) (2026-10-08)

### Bug Fixes

* **bench:** score wrapped crashes and retain recovery evidence ([#29](https://github.com/aleksandr-deich/adb-axi/issues/29)) ([38783d2](https://github.com/aleksandr-deich/adb-axi/commit/38783d26a858f88917611f15fea7bb9415127856))
* exclude Room lock files from database selection ([#34](https://github.com/aleksandr-deich/adb-axi/issues/34)) ([fec44ae](https://github.com/aleksandr-deich/adb-axi/commit/fec44aec34f780ae899d3015378c2adf7f679afc))
* prevent data db queries from accessing host files ([#32](https://github.com/aleksandr-deich/adb-axi/issues/32)) ([3d1e3e7](https://github.com/aleksandr-deich/adb-axi/commit/3d1e3e722a677e586c7ff928a6674b49b7604c0b))
* scope app state and data operations to the resolved Android user ([#33](https://github.com/aleksandr-deich/adb-axi/issues/33)) ([33bd760](https://github.com/aleksandr-deich/adb-axi/commit/33bd760cfd9c78631c31b137199c91f3f567eeba))

## [0.1.3](https://github.com/aleksandr-deich/adb-axi/compare/v0.1.2...v0.1.3) (2026-10-05)

### Features

* **bench:** add repeatable Android agent benchmark ([#22](https://github.com/aleksandr-deich/adb-axi/issues/22)) ([0d7869b](https://github.com/aleksandr-deich/adb-axi/commit/0d7869b408a6bc1c6c3c0e57aceb337bb145ece3))
* **bench:** resume benchmark runs from a configurable results directory ([#24](https://github.com/aleksandr-deich/adb-axi/issues/24)) ([f858ecb](https://github.com/aleksandr-deich/adb-axi/commit/f858ecb6a60dfb0d43f0f2af468ec3266c26bb6b))
* streamline adb-axi help and show root crash causes ([#26](https://github.com/aleksandr-deich/adb-axi/issues/26)) ([6edc801](https://github.com/aleksandr-deich/adb-axi/commit/6edc801e9242c7b02cb1943a401b48d8ddefabe8))

### Bug Fixes

* **bench:** preserve host adb authorization in isolated environments ([#25](https://github.com/aleksandr-deich/adb-axi/issues/25)) ([022378b](https://github.com/aleksandr-deich/adb-axi/commit/022378b4cf9785b2a7337203a630e9cc78cd4f49))
* **bench:** score holder and emulator recovery by outcome ([#23](https://github.com/aleksandr-deich/adb-axi/issues/23)) ([dcb1b7f](https://github.com/aleksandr-deich/adb-axi/commit/dcb1b7f23dfbe4043151fdf44f86678b946a3bb8))

## [0.1.2](https://github.com/aleksandr-deich/adb-axi/compare/v0.1.1...v0.1.2) (2026-10-04)

### Bug Fixes

* wait for app services before reporting boot complete ([#21](https://github.com/aleksandr-deich/adb-axi/issues/21)) ([048b56b](https://github.com/aleksandr-deich/adb-axi/commit/048b56bb62eb8dab0bb74cb2690894d78b6ff3f2))

## [0.1.1](https://github.com/aleksandr-deich/adb-axi/compare/v0.1.0...v0.1.1) (2026-10-04)

### Features

* **skills:** add adb-axi agent skill for npx use ([#18](https://github.com/aleksandr-deich/adb-axi/issues/18)) ([1f6dbf5](https://github.com/aleksandr-deich/adb-axi/commit/1f6dbf54cf37da5cf3c90d6ca9e5aa928b2d8cec))

### Bug Fixes

* improve adb-axi behavior on physical phones ([#19](https://github.com/aleksandr-deich/adb-axi/issues/19)) ([a21bbd4](https://github.com/aleksandr-deich/adb-axi/commit/a21bbd49b304bf31703df33649d33f18f0ec492f))

## [0.1.0](https://github.com/aleksandr-deich/adb-axi/compare/d0de5fb76be3119c1c500e0046b9701e4af13680...v0.1.0) (2026-10-04)

### Features

* add app kill, restore, and death commands ([#11](https://github.com/aleksandr-deich/adb-axi/issues/11)) ([fe64377](https://github.com/aleksandr-deich/adb-axi/commit/fe6437766728858154a7d1d68d31235367f56b88))
* **commands:** add doctor report and wait boot ([#12](https://github.com/aleksandr-deich/adb-axi/issues/12)) ([3d5cccd](https://github.com/aleksandr-deich/adb-axi/commit/3d5cccd85b465e31cc8eb08ca8f7ec99e464c56e))
* **commands:** ship app current, app list, app info and wait app ([#1](https://github.com/aleksandr-deich/adb-axi/issues/1)) ([d0de5fb](https://github.com/aleksandr-deich/adb-axi/commit/d0de5fb76be3119c1c500e0046b9701e4af13680))
* **commands:** ship the devices and shell commands ([#2](https://github.com/aleksandr-deich/adb-axi/issues/2)) ([4906e35](https://github.com/aleksandr-deich/adb-axi/commit/4906e35003fbda5d2fdb5b45a4bc57f7e4121af7))
* complete adb-axi v0.1 CLI integration ([#14](https://github.com/aleksandr-deich/adb-axi/issues/14)) ([ec54f67](https://github.com/aleksandr-deich/adb-axi/commit/ec54f6764320c61b0b4a81f0fb0799afb150ed6e))
* **data:** read debuggable app SQLite databases ([#8](https://github.com/aleksandr-deich/adb-axi/issues/8)) ([8ee4f35](https://github.com/aleksandr-deich/adb-axi/commit/8ee4f359e378b12aa68c0d8afa0df931a97626dd))
* **doctor:** diagnose and clear UiAutomation holders ([#13](https://github.com/aleksandr-deich/adb-axi/issues/13)) ([98bac91](https://github.com/aleksandr-deich/adb-axi/commit/98bac91b319228fb013bab138a5f4c9f9ccc8f2a))
* **logs:** add crash reporting for log windows ([#10](https://github.com/aleksandr-deich/adb-axi/issues/10)) ([1c19d52](https://github.com/aleksandr-deich/adb-axi/commit/1c19d52190f14451542b78f4c31740bf267e3571))
* **logs:** add marked log windows and log waits ([#7](https://github.com/aleksandr-deich/adb-axi/issues/7)) ([87ca06f](https://github.com/aleksandr-deich/adb-axi/commit/87ca06faa9756e29ccf66daae60da1833cda407d))
* ship app install and uninstall commands ([#6](https://github.com/aleksandr-deich/adb-axi/issues/6)) ([ad7e619](https://github.com/aleksandr-deich/adb-axi/commit/ad7e6190ff5d70aa57a5e34b097b66b31a101c10))
* ship app start, stop, and clear commands ([#5](https://github.com/aleksandr-deich/adb-axi/issues/5)) ([2e0923f](https://github.com/aleksandr-deich/adb-axi/commit/2e0923f0896f4c241545256c87189cf60c97abc4))

### Bug Fixes

* clarify adb-axi diagnostics and output for 0.1.0 ([#16](https://github.com/aleksandr-deich/adb-axi/issues/16)) ([6466fa3](https://github.com/aleksandr-deich/adb-axi/commit/6466fa385b26fd729b4243b3a0b5fb272474b406))
* correct device and log diagnostics before 0.1.0 ([#17](https://github.com/aleksandr-deich/adb-axi/issues/17)) ([1ae4cc0](https://github.com/aleksandr-deich/adb-axi/commit/1ae4cc07f384a790b95319aef68d03f0a11bfe18))
* prevent false log matches and clarify log and install output ([#9](https://github.com/aleksandr-deich/adb-axi/issues/9)) ([56d1b05](https://github.com/aleksandr-deich/adb-axi/commit/56d1b05db7550e4aebda4923012976e75671e7e7))
