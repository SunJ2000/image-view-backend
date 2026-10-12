# Image View Backend

个人图片、视频和通用文件库后端：NestJS + TypeScript + MySQL + 杭州 OSS。浏览器直传 OSS，后端负责授权、校验及文件信息管理。文件接口使用单个管理 Bearer Token，不包含多用户注册登录。

## 本地启动

建议使用 Node.js 24 LTS、npm、Docker Desktop（Linux 容器模式）。

本地 MySQL 从 ACR 公网仓库拉取固定版本 `8.4.11`。首次使用或换电脑后，先登录（交互输入 ACR 的 Registry 登录密码）：

```sh
docker login --username=sunj2000 crpi-v6rssvzqgx6xu67l.cn-hangzhou.personal.cr.aliyuncs.com
```

```sh
npm install
npm run setup:local
npm run db:up
npm run start:dev
```

`setup:local` 在 `.env` 不存在时生成随机管理令牌、数据库密码及 root 密码，不覆盖已有配置，也不打印密钥。查看本地 `.env` 获取 `ADMIN_API_TOKEN`；前端运行时输入，禁止打包进 `VITE_*` 变量。`.env` 已被 Git 和 Docker 构建上下文忽略。

- API：`http://localhost:3000/api`
- 健康检查：`GET /api/health`（无令牌，检查数据库；`ossConfigured` 只表示 OSS 配置齐全，不代表已验证云端权限）
- 开发接口文档：`http://localhost:3000/api/docs`，Authorize 中输入管理令牌
- 默认 Vue 开发域名：`http://localhost:5173`，通过 `CORS_ORIGINS` 配置多个域名，以英文逗号分隔
- 数据库：仅绑定 `127.0.0.1:3306`，数据保存到 Compose 的 `mysql_data` 卷

首次启动自动执行显式数据库迁移，`synchronize` 始终关闭。`npm run db:down` 停止数据库但保留数据；不要执行 `docker compose down -v`，那会删除数据卷。数据库镜像首次初始化后，修改 `.env` 密码不会自动修改已有数据库用户密码。

## OSS 配置

在 `.env` 填写：

```dotenv
OSS_REGION=oss-cn-hangzhou
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
OSS_BUCKET=image-sj
OSS_ACCESS_KEY_ID=服务端AccessKeyId
OSS_ACCESS_KEY_SECRET=服务端AccessKeySecret
OSS_STS_ROLE_ARN=
UPLOAD_URL_TTL_SECONDS=900
```

**STS 角色不是必填项。** `OSS_STS_ROLE_ARN` 留空时，后端返回单对象 V4 PUT 预签名 URL；浏览器直接向该 URL 上传原始文件。长期凭证只保留在服务端 `.env`，不会向前端返回 AccessKey Secret。签名 URL 默认有效 15 分钟，可通过 `UPLOAD_URL_TTL_SECONDS` 修改。这种模式支持不超过 5 GiB 的单文件上传，不支持分片断点续传。

配置角色 ARN 后自动改用 STS，支持 OSS SDK 分片上传和断点续传。OSS 必需的 Bucket 和访问凭证留空时仍可启动数据库、健康检查和文件列表；上传相关接口返回 503。

1. 使用杭州地域的私有 Bucket。Bucket 策略不要授予匿名读取，也不要启用阻止本项目管理身份删除文件的保留策略。
2. 签名直传模式的服务端权限模板见 `docs/oss-signed-upload-policy.json`，包含对象读、写、设置 private ACL、删除和取消分片权限，不需要 `sts:AssumeRole`。
3. **可选 STS 模式**：创建受信任实体为阿里云账号的 RAM 角色，允许服务端 RAM 用户 AssumeRole。角色授权模板见 `docs/oss-upload-role-policy.json`；服务端用户额外权限见 `docs/oss-server-policy.json`，替换 Bucket、账号 ID 和角色名称。然后设置 `.env` 的 `OSS_STS_ROLE_ARN`。
4. Bucket CORS：来源填写 `http://localhost:5173` 和正式前端域名；允许 `GET, HEAD, PUT, POST, DELETE`；允许请求头可设为 `*`；暴露 `ETag, x-oss-request-id, Content-Length, Content-Range, Accept-Ranges`。OSS CORS 与后端 `CORS_ORIGINS` 是两处独立配置。
5. **配置 OSS 生命周期**：对 `staging/` 前缀的对象在 2 天后删除；对 `staging/`、`files/` 的未完成分片建议 2 天后清理。不要对 `files/` 已完成对象设置自动删除规则。第一版建议使用未开启版本控制的独立 Bucket；已开启版本控制时，额外配置非当前版本清理，否则 DeleteObject 不会立即清除历史版本。

签名直传 URL 仅授权对一个精确 staging 对象执行 PUT，Content-Type 也纳入签名。STS 模式的角色权限限定到 `staging/*`，每次会话进一步限定到一个精确对象；不授予 Bucket 列举、文件读取或删除权限。临时凭证默认有效 15 分钟。

官方参考：[Node.js 预签名 URL 上传](https://help.aliyun.com/zh/oss/developer-reference/upload-objects-using-a-signed-url-generated-with-oss-sdk-for-node-js/)、[客户端直传](https://www.alibabacloud.com/help/en/oss/user-guide/uploading-objects-to-oss-directly-from-clients/)、[分片上传权限](https://help.aliyun.com/zh/oss/user-guide/multipart-upload/)。

## 前端接入

所有文件和上传接口都需要：

```http
Authorization: Bearer <ADMIN_API_TOKEN>
Content-Type: application/json
```

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| POST | `/api/uploads/init` | 创建上传记录，返回签名上传 URL 或 STS 凭证 |
| POST | `/api/uploads/:id/credentials` | 续期同一待上传文件的签名 URL 或 STS 凭证 |
| POST | `/api/uploads/:id/complete` | 验证 OSS 对象并入库，重复调用结果一致 |
| GET | `/api/files` | 分页、名称搜索及类型筛选 |
| GET | `/api/files/:id` | 文件详情 |
| GET | `/api/files/:id/preview-url` | 临时读取 URL；`mode=download` 强制下载 |
| PATCH | `/api/files/:id` | 修改展示名称 |
| DELETE | `/api/files/:id` | 删除 OSS 文件并保留软删除记录 |

上传初始化请求：

```json
{ "fileName": "photo.jpg", "sizeBytes": 102400, "mimeType": "image/jpeg" }
```

未配置 STS 角色时的返回值结构：

```json
{
  "file": { "id": "UUID", "objectKey": "files/UUID.jpg", "status": "pending" },
  "upload": {
    "mode": "signed-put", "method": "PUT", "url": "https://image-sj.oss-cn-hangzhou.aliyuncs.com/staging/UUID.jpg?签名参数",
    "headers": { "Content-Type": "image/jpeg", "x-oss-object-acl": "private" }, "expiresAt": "ISO时间",
    "region": "oss-cn-hangzhou", "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
    "bucket": "image-sj", "objectKey": "staging/UUID.jpg"
  },
  "maxFileSizeBytes": 5368709120
}
```

前端使用 `fetch(upload.url, { method: 'PUT', headers: upload.headers, body: file })`，直接发送原始 File，不使用 FormData，不附带后端管理令牌。签名过期可用同一 file ID 续期后重新上传整个文件。

配置角色后返回 STS 结构：

```json
{
  "file": { "id": "UUID", "objectKey": "files/UUID.jpg", "status": "pending" },
  "upload": {
    "accessKeyId": "临时ID", "accessKeySecret": "临时Secret", "stsToken": "临时Token",
    "mode": "sts",
    "headers": { "x-oss-object-acl": "private" },
    "expiresAt": "ISO时间", "region": "oss-cn-hangzhou",
    "endpoint": "https://oss-cn-hangzhou.aliyuncs.com", "bucket": "你的Bucket",
    "objectKey": "staging/UUID.jpg"
  },
  "maxFileSizeBytes": 5368709120
}
```

**浏览器必须上传到 `upload.objectKey`，然后用 `file.id` 调完成接口。** `file.objectKey` 是后端最终保存路径，浏览器没有写入权限。示例见 `docs/vue-upload.ts.example`，前端安装 `ali-oss` 并配置 `/api` 开发代理到 `http://localhost:3000`。跨源调用也可以直接使用后端地址。

后端 HEAD 检查实际大小、Content-Type，并使用源 ETag 条件拷贝到 private 的 `files/` 对象。大于 1 GiB 的视频使用 OSS 分片拷贝，不经过应用服务器下载。源对象若在校验期间变化，完成接口返回 409，可重试。事务和行锁串行处理同一文件的完成、续期和删除。

Content-Type 是对象元数据，**不是文件内容鉴定**。本版本不扫描文件内容、不提取宽高/时长、不生成封面、不转码。类型判断按 MIME；不确定类型请使用 `application/octet-stream`。STS 无法按这个实现强制限制上传字节数：前端预检和完成接口校验大小，超出声明大小的对象无法入库，可删除取消，并由生命周期兜底清理。

列表默认只返回 `ready`：

```text
GET /api/files?page=1&pageSize=20&mediaType=image&search=旅行
GET /api/files?status=pending
PATCH /api/files/:id  { "displayName": "新的名字" }
```

常见图片和 MP4/WebM/Ogg 视频返回 inline 预览地址；HTML、SVG 和其他类型强制下载，避免执行活动内容。实际播放能力取决于浏览器和视频编码。预览 URL 默认有效 1 小时，可通过 `PREVIEW_URL_TTL_SECONDS` 调整；长视频失效后前端需重新获取 URL 并恢复播放进度。数据库保存对象路径，不保存签名 URL。授权接口响应设置 `Cache-Control: no-store`。

未完成上传会话默认 24 小时过期。后台每分钟处理至多 50 条过期待上传记录或待删除记录；OSS 删除失败时保留 `deleting` 状态自动重试。完成上传的 staging 对象保留到生命周期清理，因为客户端仍可能持有有效上传授权；生命周期配置不可省略。

错误响应统一为 `{ statusCode, message, path, timestamp }`。400 表示参数或上传元数据不匹配；401 未授权；404 文件不存在；409 状态冲突；429 限流；502 云端操作失败；503 OSS 尚未配置或数据库不可用。

## Linux 部署

### ACR 构建与服务器运行

`Dockerfile` 负责构建后端镜像，保留 Node.js 24 的多阶段构建，由 ACR 执行。ACR 构建规则使用代码仓库根目录 `/`、`Dockerfile`，输出镜像标签可设为 `main`。等待镜像构建成功后再部署。

`compose.yaml` 负责运行后端和 MySQL：使用 ACR 杭州公网地址，MySQL 固定为 `8.4.11`，后端标签从 `.env` 的 `BACKEND_IMAGE_TAG` 读取，未设置时默认为 `main`。标签必须是 ACR 仓库中已存在的版本；若构建输出为 `latest`，就设置 `BACKEND_IMAGE_TAG=latest`。Compose 不再配置 `build`，服务器无需拉取 Node 基础镜像或执行 npm 安装。

当前 ECS 在上海、ACR 在杭州，因此服务器使用公网地址。个人版杭州 VPC 地址仅供同地域 VPC 网络客户端使用，不能直接用于上海服务器。本地 `npm run db:up` 会合并 `compose.dev.yaml`，使用同一个公网 MySQL 镜像，并开放本地数据库端口。

服务器安装 Docker Engine 和 Compose 插件，准备 `compose.yaml` 和服务器专用 `.env` 即可运行；可以通过 Git 拉取项目获取配置文件。创建 `.env` 时使用独立的管理令牌和密码，填写 OSS 配置，并修改正式 `CORS_ORIGINS`。在这两个文件所在目录执行：

```sh
docker login --username=sunj2000 crpi-v6rssvzqgx6xu67l.cn-hangzhou.personal.cr.aliyuncs.com
docker compose --profile production pull
docker compose --profile production up -d --no-build
docker compose --profile production ps
curl -f http://127.0.0.1:3000/api/health
```

登录时交互输入 ACR 的 Registry 登录密码，不要写进 Git 或 Dockerfile。配置文件更新需要先同步到服务器；代码更新则先等待 ACR 构建完成，再执行以下命令更新后端：

```sh
docker compose --profile production pull backend
docker compose --profile production up -d --no-build backend
docker compose --profile production logs --tail=100 backend
```

### 端口与数据

生产配置不映射 MySQL 公网端口，后端仅绑定服务器 `127.0.0.1:3000`。使用宿主机 Nginx 做 HTTPS 反向代理，示例见 `deploy/nginx.conf.example`。Vue3 构建产物由同一 Nginx 提供。生产镜像以非 root 用户运行，关闭 Swagger，并有健康检查和日志大小限制。配置使用公网 OSS endpoint，确保浏览器能够访问返回的签名 URL。

数据库卷只是持久化，不是备份。应定期使用 `mysqldump --single-transaction` 导出，并把备份放到另一台机器或专用 OSS 备份位置。升级前备份数据库；未来数据库结构变更增加新的迁移文件，不修改已经执行过的迁移。

```sh
npm run build
npm run migration:run
# 回滚会删除本次迁移建立的表；仅在明确需要时执行
npm run migration:revert
```

## 验证

```sh
npm run build
npm run lint
npm test
npm run test:e2e
```

单元测试覆盖上传状态、元数据校验、对象级授权、幂等完成、条件拷贝、大文件分片拷贝、删除重试等。HTTP 测试覆盖真实 Nest 请求管线的管理鉴权、参数转换、请求校验和 CORS，使用替代服务，不需要云端凭证或 MySQL。
