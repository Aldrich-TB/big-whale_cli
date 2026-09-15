# whale

本地代码小助手。基于 Ollama 的轻量 CLI，支持对话生成代码并写入文件。

零依赖，只用 Node.js 内置模块。代码可审计，无供应链风险。

## 环境要求

- Node.js 16 或更高版本
- Ollama 已安装并运行
- 已下载代码模型（推荐 qwen2.5-coder:7b）

## 安装

把 whale.js 放到任意目录，加执行权限：

    chmod +x whale.js

可选：添加别名

    echo 'alias whale="node ~/whale.js"' >> ~/.zshrc
    source ~/.zshrc

## 快速开始

进入项目目录，启动：

    node ~/whale.js

启动后先检测连接：

    /test

正常后直接说话：

    写一个 check_phone 函数到 solution.py

它会生成代码，预览，等你按 y 确认后写入。

## 工作目录

默认锁定在启动时的当前目录。所有文件读写都限制在这个目录内，路径越界会被拒绝。

指定其他目录：

    node ~/whale.js --root ~/projects/foo

## 模式

模式决定它生成代码后怎么处理文件。

    /chat    纯聊天。不生成代码，不碰文件。
    /sec     只显示代码，绝不写入任何文件。
    /ask     预览代码，按 y 确认才写入。默认模式。
    /auto    生成后直接写入，不确认。
    /yolo    自动写入，并允许运行命令。

快捷切换：输入 /chat、/sec、/ask、/auto、/yolo 回车即可。

查看当前模式：

    /mode

## 对话示例

生成新文件：

    写一个 Luhn 校验函数到 check.py

追加到已有文件：

    再加一个 check_email 到 check.py

修改现有文件：

    把 check.py 里的银行卡长度从 19 改成 16

查看文件：

    看下 check.py

运行文件（需要 yolo 模式）：

    跑一下 check.py

纯聊天：

    解释一下 Luhn 算法的原理

它根据你说的内容自动判断要做什么，不用记命令。

## 命令

    /help        显示帮助
    /test        检测 Ollama 连接，5 秒超时
    /conf        查看和修改配置
    /mode        显示当前模式
    /files       列出当前目录文件
    /root        显示工作目录
    /clear       清空对话历史
    /exit        退出

## 配置

查看当前配置：

    /conf

修改配置：

    /conf model <名称>      切换模型
    /conf url   <地址>      Ollama 服务地址
    /conf theme <名称>      切换主题
    /conf mode  <名称>      默认模式
    /conf reset              恢复默认

配置保存在当前目录下 `.whale.json`，重启后自动加载。

优先级：命令行参数 > 环境变量 > 配置文件 > 内置默认。

## 主题

内置四套配色：

    claude    暖橙色，Claude 风格
    ocean     蓝青色
    matrix    黑客绿
    sakura    粉色

切换：

    /theme sakura

输入 /theme 后按 Tab 可补全。

## 输入菜单

输入 / 会弹出菜单。

    ←  →    切换分类
    ↑  ↓    在当前分类里选命令
    Enter   执行选中命令
    Tab     填入选中命令，或补全文件名
    Esc     关闭菜单

继续打字会自动过滤。例如输入 /s，只显示以 s 开头的命令。

## 连接 Ollama

默认地址 http://192.168.1.1:11434。如需修改：

    /conf url http://your-host:11434

或者用环境变量：

    OLLAMA_URL=http://your-host:11434 node ~/whale.js

## Ollama 监听所有网卡

如果 Ollama 跑在另一台机器上（比如 Windows 主机，Kali 虚拟机通过局域网访问），需要让 Ollama 监听 0.0.0.0。

Windows 临时（管理员 PowerShell）：

    Get-Process ollama* -ErrorAction SilentlyContinue | Stop-Process -Force
    $env:OLLAMA_HOST="0.0.0.0:11434"
    ollama serve

Windows 永久：新建系统环境变量 OLLAMA_HOST 值为 0.0.0.0:11434，彻底退出 Ollama 后重新打开。

Linux 或 macOS 临时：

    OLLAMA_HOST=0.0.0.0 ollama serve

Linux 永久（systemd）：

    sudo systemctl edit ollama

在编辑器中加入：

    [Service]
    Environment="OLLAMA_HOST=0.0.0.0:11434"

保存后：

    sudo systemctl daemon-reload
    sudo systemctl restart ollama

防火墙放行 11434 端口。

Windows 管理员 PowerShell：

    New-NetFirewallRule -DisplayName "Ollama" -Direction Inbound -Protocol TCP -LocalPort 11434 -Action Allow

Linux：

    sudo ufw allow 11434/tcp

验证：

    curl http://your-host:11434/api/tags

返回模型列表说明配置成功。

## 安全说明

文件操作有三层保护：

- 工作目录锁定。所有路径都限制在 --root 指定的目录内，路径越界直接拒绝。
- 写入前预览。ask 模式下每次写入都要按 y 确认。
- 自动备份。每次覆盖或修改前，原文件备份为 .bak.时间戳。

代码完全开源可审计。只用 Node.js 标准库，无第三方依赖。

## 常见问题

连接失败：

    运行 /test 查看详细排查步骤。

模型未找到：

    /conf model 切换成已下载的模型，或 ollama pull 下载新模型。

生成速度慢：

    关掉其他占显存的程序。6GB 显存跑 7B 模型已经接近上限。
    可换用更小的模型：ollama pull qwen2.5-coder:3b，然后 /conf model qwen2.5-coder:3b。

输出带 markdown 代码块：

    提示词里加一句「只输出代码，不要 markdown」，或用 sec 模式查看后手动复制。

文件被覆盖：

    查看同目录下的 .bak.时间戳 文件，改回即可。
    以后可用 sec 模式先看再决定。

## 提示词技巧

模型对具体、明确的指令响应更好。

好的提示词：

    写一个 check_id_card 函数，18 位身份证号，GB11643-1999 校验。
    权重 [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2]，
    余数对应 ['1','0','X','9','8','7','6','5','4','3','2']。
    返回 True 或 False。

模糊的提示词：

    写个身份证校验

生成结果不对时，直接指出错误：

    权重数组错了，应该是 17 个元素，最后一个是 2。
    重写一遍。

## 文件结构

    whale.js          主程序
    ~/.whale.json     配置文件
    *.bak.时间戳      自动备份

## 许可

自由使用和修改。
