# 安装与更新

目标服务器需要 Codex Proxy RS `3.18.1` 或更高的 `3.x` 版本，平台为 `x86_64-unknown-linux-gnu`。插件包和 companion Worker 镜像必须来自同一个 GitHub Release。自 `v0.1.12` 起，Worker 连接到 RS 的固定 Docker 网络，通过 `cpr-twofa-worker` 服务名访问；RS 容器重启不会改变 Worker 的网络命名空间。

## 首次安装

先下载 Release 中的插件归档、对应 `.sha256`、Worker bundle、bundle `.sha256`、`companion-manifest.json` 和两个 companion 脚本。核对摘要：

```bash
sha256sum -c david1989sky.codex-proxy-twofa-0.1.13-x86_64-unknown-linux-gnu.tar.gz.sha256
sha256sum -c codex-proxy-twofa-worker-0.1.13.tar.gz.sha256
```

从清单取出固定的镜像摘要，然后在 RS 主机执行：

```bash
export PUBLIC_ORIGIN=https://cx.subarx.com
export WORKER_IMAGE=ghcr.io/david1989sky/codex-proxy-twofa-worker:v0.1.13@sha256:<清单中的 digest>
export WORKER_BUNDLE=/path/to/codex-proxy-twofa-worker-0.1.13.tar.gz
export CPR_TWOFA_RS_CONTAINER=codex-proxy-rs-v380-codex-proxy-rs-1
export CPR_TWOFA_RS_NETWORK=codex-proxy-rs-v380_default
sudo -E bash companion-install.sh
```

`CPR_TWOFA_RS_CONTAINER` 和 `CPR_TWOFA_RS_NETWORK` 必须指向当前 RS 容器及其 Docker 网络。Worker 独立连接到该网络，不发布宿主机端口；部署脚本从 RS 容器访问 Worker 的 `/health`，并从 Worker 访问 RS 的认证状态接口。脚本使用现有 `/opt/cpr-twofa/data/credentials` 和 `/opt/cpr-twofa/secrets/twofa-key` 挂载。空凭据目录首次安装时才会生成密钥；已有数据但缺少密钥会停止部署。

RS 日常升级须保持原有 Compose 项目和 Docker 网络；如果迁移到新的 Compose 项目或网络，先用新的 `CPR_TWOFA_RS_CONTAINER`、`CPR_TWOFA_RS_NETWORK` 重新部署 Worker，再切换插件流量。普通 RS 容器重建不需要重建 Worker。

Worker 就绪后，在 RS「插件管理」上传插件归档，核对安装包摘要，确认完整信任并启用。插件配置填写：

```text
workerBaseUrl = http://cpr-twofa-worker:28082
workerImageDigest = sha256:<同一份清单中的 digest>
```

打开「批量 2FA 授权」页面，刷新状态并执行一次「确认迁移」。迁移只写入 RS 插件状态，不读取或移动加密凭据。

## 更新

每次更新先备份当前 Release 目录和加密凭据目录，再下载新版本的 bundle 和镜像摘要：

```bash
export PUBLIC_ORIGIN=https://cx.subarx.com
export WORKER_IMAGE=ghcr.io/david1989sky/codex-proxy-twofa-worker:v0.1.13@sha256:<新版本 digest>
export WORKER_BUNDLE=/path/to/codex-proxy-twofa-worker-0.1.13.tar.gz
export CPR_TWOFA_RS_CONTAINER=codex-proxy-rs-v380-codex-proxy-rs-1
export CPR_TWOFA_RS_NETWORK=codex-proxy-rs-v380_default
sudo -E bash companion-update.sh
```

从 `v0.1.11` 或更早版本迁移时，先备份整个 Worker Release 目录、加密凭据目录及密钥，并确保没有授权任务正在执行。新安装脚本会与旧重绑任务互斥，在切换前停用 `cpr-twofa-rebind-worker.timer`；升级失败时恢复旧 Worker 和定时器，成功后保留定时器停用状态。旧定时器会误判新 Worker 的独立网络并反复重建它。Worker 就绪后，在 RS「插件管理」上传同版本插件，并将已有实例的 `workerBaseUrl` 改为 `http://cpr-twofa-worker:28082`。`workerImageDigest` 须与新 Release 清单一致。

## 回滚

Worker 健康检查失败时，旧镜像仍保留在本机。执行：

```bash
sudo bash companion-update.sh --rollback
```

此命令会使用安装脚本留下的上一个 Release 快照，恢复旧 Compose 文件、镜像和原有重绑定时器状态。跨越 `v0.1.12` 网络迁移回滚时，还需在 RS「插件管理」切回旧插件包和 `http://127.0.0.1:28082`。加密凭据目录与密钥始终保留。

## 卸载

先在 RS 中停用并卸载插件，再停止 companion Worker：

```bash
docker compose -p cpr-twofa -f /opt/cpr-twofa/release/codex-proxy-twofa-worker/ops/compose.yaml down
```

加密凭据目录和密钥不会自动删除。确认不再需要这些账号后，按组织的备份和销毁流程处理 `/opt/cpr-twofa/data/credentials` 与 `/opt/cpr-twofa/secrets/twofa-key`。
