# QFRemote（Windows 控制端）

QFRemote 是我们自有的远程控制软件：电脑装一次，之后用电脑软件或手机浏览器打开，就能连上你的电脑。

- 官方网站与下载：见官网（GitHub Pages，仓库 `qfremote-website`）
- 安装包：见本仓库 Releases（只认正式版，草稿与预发布不要下载）
- 每个安装包都会公布 SHA-256 校验值，下载后可对照确认没被掉包

## 发版流程（写死三步）

1. 新安装包传到本仓库 Releases（正式版）；
2. 更新服务端软件内更新的版本清单；
3. 同步官网 `qfremote-website` 仓库的 `product.json`（版本/下载/校验码/日志/截图/功能点）。

QFRemote 基于开源项目 MeshCentral（Apache-2.0 许可证）构建。
