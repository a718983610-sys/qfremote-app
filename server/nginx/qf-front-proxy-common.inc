# QFRemote 前端反代公共头（S-078 纳入仓库；S-088 代理契约公共部分）
# ================================================================
# 部署：随 qfremote-proxy 一并拷到 /etc/nginx/qf-front-proxy-common.inc，
# 部署清单（deploy/manifest.yml）登记本文件 hash，部署后以 nginx -T
# 输出做指纹比对。修改前须核对线上 /etc/nginx 同名文件。
#
# 本文件只放“所有反代位置共用”的请求头，不放超时／缓冲／body 上限
# （各 location 按契约自定，见 PROXY-CONTRACTS.md）。
# 不含 Upgrade/Connection——WebSocket 位置（.ashx、/console-engine/）
# 各自显式设置；普通 API 位置不需要升级头。
# 不含 add_header——安全头统一在 qfremote-proxy-headers.conf 里出，
# 两处各管各的，避免 nginx add_header 继承覆盖互相吞掉。
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# 公网唯一入口是 Cloudflare HTTPS 隧道，X-Forwarded-Proto 恒为 https；
# 不取 $scheme（nginx 与 cloudflared 之间是明文 http，取它会谎报 http）。
proxy_set_header X-Forwarded-Proto https;
# S-091：Cloudflare 边缘注入的真实客户端 IP，原样透传给后端
# （边缘会覆写该头，客户端自带值到不了这里；后端只认回环来源的该头）。
proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
