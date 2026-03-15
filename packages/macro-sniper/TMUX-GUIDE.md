# tmux 使用指南

服务器上使用 tmux 保持 pi 会话持久化，防止 SSH 断连丢失进程。

## 首次使用

```bash
ssh root@你的服务器
tmux new -s pi
cd /root/pi-mono/pi-mono/packages/macro-sniper
pi
```

## 断连后重连

```bash
ssh root@你的服务器
tmux attach -t pi
```

直接回到原来的 pi 界面，进程一直在跑，不需要 `pi -c`。

## 常用快捷键

| 快捷键 | 说明 |
|--------|------|
| `Ctrl+B D` | 手动断开 tmux（进程继续后台运行） |
| `Ctrl+B [` | 滚动查看历史输出（`q` 退出） |
| `Ctrl+B C` | 新建窗口 |
| `Ctrl+B N` | 切换到下一个窗口 |
| `Ctrl+B P` | 切换到上一个窗口 |

## 常用命令

```bash
tmux ls                  # 列出所有会话
tmux attach -t pi        # 连接到名为 pi 的会话
tmux kill-session -t pi  # 关闭名为 pi 的会话
```

## 备注

- tmux 只需在服务器端安装，客户端无需安装
- 服务器已配置 SSH 心跳（`ClientAliveInterval 60`），减少空闲断连
