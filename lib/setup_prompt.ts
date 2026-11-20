// The setup prompt: the text a person pastes into Claude Code on a new computer (macOS, Linux, or
// Windows through WSL 2), so Claude Code installs Thoth, joins the cloud brain, keeps the computer on
// and checks the result (multi-device plan, PR 8; Windows helper plan, W5).
// The logic is in `thoth setup`, `thoth always-on` and `thoth doctor --json`; the prompt only runs
// them in order and follows what they print. It holds no secret and no account name.
//   setupPrompt(lang, { install })                         the website's prompt (the website holds the
//                                                          same text: a test checks it)
//   setupPrompt(lang, { install, hub, join, name })        the main panel's ready-made prompt for one
//                                                          new helper (Add a Computer, cloud brain)

export type PromptLang = 'en' | 'zh';

export interface PromptOptions {
  /** the address of install.sh (the one-line install command) */
  install: string;
  /** the cloud brain (https://...); set together with join and name for the ready-made prompt */
  hub?: string;
  /** a pre-approved one-time code (no Approve needed) */
  join?: string;
  name?: string;
}

/** The install line of the main panel's prompt. thoth.build/install.sh forwards to the latest
 * release, so the product holds no account name.*/
export const PANEL_INSTALL = 'https://thoth.build/install.sh';

function en(o: PromptOptions, filled: boolean): string {
  const values = filled
    ? `3. Use these values. Do not ask me for them:
   role: helper; cloud brain: ${o.hub ?? ''}; name: ${o.name ?? ''}; one-time code: ${o.join ?? ''} (it works once, for 15 minutes).`
    : `3. Ask me two questions, then wait for my answers:
   a. "Is this computer a helper (a spare computer that runs tasks for your main computer) or your main computer?" The default is helper.
   b. "What is the address of your cloud brain (https://...)? Thoth on your main computer shows it under File > Set Up Devices…"
   For a main computer, also ask me for my owner link (ccbrain://...). It is a secret: put it only in the command and do not repeat it to me. Tell me first that this chat is saved on this computer (in Claude Code's history), so the link is stored there too.
   You may also ask me for a short name for this computer (small letters, digits and -). Without one, Thoth uses the host name.`;
  const join = filled
    ? `4. Join. Run: thoth setup --role helper --hub ${o.hub ?? ''} --join ${o.join ?? ''} --name ${o.name ?? ''}`
    : `4. Join. Run one of these:
   helper: thoth setup --role helper --hub <address> [--name <name>]
   main:   thoth setup --role main --connect '<owner link>' [--name <name>]`;
  return `Set up this computer as a computer of my Thoth (https://thoth.build). It works on macOS, on Linux, and on Windows 10 (version 2004 or newer) or 11.
Run each step yourself in this terminal and read its output. When a step needs me, ask me and wait for my answer. Never use sleep or a loop to wait.

1. Windows only (on macOS or Linux, go to step 2). Thoth runs in WSL 2 (Linux in Windows). If this terminal is already in WSL (/proc/version contains "microsoft"), this is Windows too: do steps c to e here without the wsl -d wrapper (as root, with no password: wsl.exe -d "$WSL_DISTRO_NAME" -u root --exec bash -lc '<command>'), and use the Windows part of step 5. There, do not run wsl --shutdown yourself (it stops this terminal too): tell me to run it in PowerShell, open Ubuntu again and paste this prompt again, then stop.
   a. Run: WSL_UTF8=1 wsl -l -v
      If no distro has VERSION 2, tell me: "Open PowerShell as administrator and run: wsl --install -d Ubuntu-24.04. Restart Windows if it asks. Then open Ubuntu from the Start menu and set a Linux user name and password." Then stop and wait for my answer. When I say it is done, run WSL_UTF8=1 wsl -l -v again.
   b. Use the WSL 2 distro as <distro>. From now on, run every command of this prompt in it: wsl -d <distro> --exec bash -lc '<command>'. A command that needs sudo runs as root with no password: wsl -d <distro> -u root --exec bash -lc '<command>'. In <command>, use double quotes, not single quotes (for example around the owner link). Run these wsl commands with Bash (Git Bash), not PowerShell: PowerShell changes the quotes.
   c. Run: systemctl --user show-environment
      If it fails, systemd is off: as root, add the two lines [boot] and systemd=true to /etc/wsl.conf, run wsl --shutdown (in Windows), then run the check again.
   d. As root, run: apt-get update && apt-get install -y tmux python3 curl build-essential
   e. If claude is not found in WSL, run: curl -fsSL https://claude.ai/install.sh | bash
      Then tell me: "Open Ubuntu from the Start menu, run claude and log in. It shows a web address: open it in your browser. Then type /exit." Wait for my answer. Only I can do this.
2. Install. Run: thoth doctor --json
   If the command is not found or does not print JSON, install Thoth: curl -fsSL ${o.install} | bash
   If the install stops and names commands to run first, run them, then run the install again. If sudo asks for a password, ask me to run the command and wait.
   Then run thoth doctor --json again. If thoth is still not found, use ~/.local/bin/thoth.
${values}
${join}
   - Exit code 0: done. Go to step 5.
   - Exit code 6: it waits for my Approve. Tell me: "In Thoth on your main computer, open File > Set Up Devices… and choose Approve for this computer." Then stop and wait for my answer. When I say it is done, run the same command again.
   - Another exit code: show me the FAILED line. If it names a thoth command, run that command, then the same setup command again. Ask me before anything else.
5. Keep it on (helper only; skip this step for a main computer). Do nothing in this step before I answer.
   macOS: ask me: "Keep this Mac on all the time? It then stays on even with the lid closed and on battery; the display may still turn off. A closed laptop in a bag stays awake and can get warm. This changes its power settings and needs your Mac password once."
   If I say yes: run thoth always-on. If it says it needs a terminal for the password, tell me to open the Terminal app and run the same command there, and wait for my answer.
   Windows: ask me: "Keep this PC on all the time? It then does not sleep, on AC power and on battery; the display may still turn off. WSL keeps running, also after a restart. This changes the power settings and adds a Windows task. It may need administrator rights."
   If I say yes: run thoth always-on. If it prints commands for an administrator, show them to me, tell me to run them in PowerShell as administrator, and wait for my answer. If I say no, tell me: "Thoth stops when Windows sleeps or WSL stops."
   macOS and Windows: then run thoth always-on --status. Tell me: "To undo it later, run: thoth always-on --undo"
   Linux: Thoth does not change power settings on Linux. Ask me: "Keep Thoth running after logout and after a restart? This adds systemd user services."
   If I say yes: run thoth services install. If it names a sudo command, ask me to run it and wait. Tell me: "Make sure this computer does not sleep (in its system settings). To undo it later, run: thoth services uninstall"
6. Check. Run: thoth doctor --json
   For each check with "ok": false, do what its "fix" field says (ask me first when the fix needs me), then run thoth doctor --json again.
7. Report to me in at most 7 short lines: the system, the role, the name, the cloud brain, keep it on (on, off or skipped), and each check that is not ok with its fix.
Never print, save or repeat a token, a code or an owner link.`;
}

function zh(o: PromptOptions, filled: boolean): string {
  const values = filled
    ? `3. 用下面的值，不要再问我：
   角色：helper；云端 brain：${o.hub ?? ''}；名字：${o.name ?? ''}；一次性代码：${o.join ?? ''}（只能用一次，15 分钟内有效）。`
    : `3. 问我两个问题，等我回答：
   a. "这台电脑是备用机（替主力机跑任务的空闲电脑），还是你的主力机？" 默认是备用机。
   b. "你的云端 brain 地址是什么（https://...）？主力机上的 Thoth 在 File > Set Up Devices… 里显示它。"
   如果是主力机，还要问我的 owner 链接（ccbrain://...）。它是密钥：只放在命令里，不要向我复述。先告诉我：这段对话会保存在这台电脑上（Claude Code 的历史记录里），所以链接也会存在那里。
   也可以问我这台电脑的短名字（小写字母、数字和 -）。不给的话，Thoth 用主机名。`;
  const join = filled
    ? `4. 加入。运行：thoth setup --role helper --hub ${o.hub ?? ''} --join ${o.join ?? ''} --name ${o.name ?? ''}`
    : `4. 加入。运行其中一条：
   备用机：thoth setup --role helper --hub <地址> [--name <名字>]
   主力机：thoth setup --role main --connect '<owner 链接>' [--name <名字>]`;
  return `把这台电脑配置成我的 Thoth（https://thoth.build）里的一台电脑。支持 macOS、Linux，以及 Windows 10（2004 或更新版本）和 Windows 11。
每一步都由你在这个终端里运行，并读它的输出。需要我的时候，问我，等我回答。不要用 sleep 或循环来等待。

1. 只对 Windows（macOS 或 Linux 直接进入第 2 步）。Thoth 在 WSL 2（Windows 里的 Linux）中运行。如果这个终端已经在 WSL 里（/proc/version 含有 "microsoft"），也算 Windows：在这里直接做 c 到 e，不用 wsl -d 包装（root 命令不用密码：wsl.exe -d "$WSL_DISTRO_NAME" -u root --exec bash -lc '<命令>'），第 5 步用 Windows 的部分。这时不要自己运行 wsl --shutdown（它也会关掉这个终端）：告诉我在 PowerShell 里运行它，重新打开 Ubuntu，再粘贴一次这段 prompt，然后停下。
   a. 运行：WSL_UTF8=1 wsl -l -v
      如果没有 VERSION 为 2 的发行版，告诉我："请用管理员身份打开 PowerShell，运行：wsl --install -d Ubuntu-24.04。如果要求重启，就重启 Windows。然后从开始菜单打开 Ubuntu，设置 Linux 用户名和密码。" 然后停下，等我回答。我说好了以后，再运行 WSL_UTF8=1 wsl -l -v。
   b. 把这个 WSL 2 发行版记为 <distro>。从这里开始，这段 prompt 里的每条命令都在它里面运行：wsl -d <distro> --exec bash -lc '<命令>'。需要 sudo 的命令用 root 运行，不需要密码：wsl -d <distro> -u root --exec bash -lc '<命令>'。<命令> 里用双引号，不要用单引号（例如 owner 链接两边）。用 Bash（Git Bash）运行这些 wsl 命令，不要用 PowerShell：PowerShell 会改掉引号。
   c. 运行：systemctl --user show-environment
      如果失败，说明 systemd 没有开：用 root 在 /etc/wsl.conf 里加上两行 [boot] 和 systemd=true，在 Windows 里运行 wsl --shutdown，然后再检查一次。
   d. 用 root 运行：apt-get update && apt-get install -y tmux python3 curl build-essential
   e. 如果 WSL 里找不到 claude，运行：curl -fsSL https://claude.ai/install.sh | bash
      然后告诉我："请从开始菜单打开 Ubuntu，运行 claude 并登录。它会给出一个网址：在浏览器里打开它。然后输入 /exit。" 等我回答。这一步只能我自己做。
2. 安装。运行：thoth doctor --json
   如果找不到这个命令，或者它没有输出 JSON，就安装 Thoth：curl -fsSL ${o.install} | bash
   如果安装停下来，并给出要先运行的命令，就运行它们，再重新安装。如果 sudo 要密码，就请我运行那条命令，等我回答。
   然后再运行 thoth doctor --json。如果还是找不到 thoth，用 ~/.local/bin/thoth。
${values}
${join}
   - 退出码 0：完成。进入第 5 步。
   - 退出码 6：在等我点 Approve。告诉我："请在主力机的 Thoth 里打开 File > Set Up Devices…，为这台电脑选择 Approve。" 然后停下，等我回答。我说好了以后，再运行同一条命令。
   - 其他退出码：把 FAILED 那一行给我看。如果它给出一条 thoth 命令，就运行它，再运行同一条 setup 命令。别的事先问我。
5. 保持常开（只对备用机；主力机跳过这一步）。这一步在我回答之前什么都不要做。
   macOS：问我："让这台 Mac 一直保持运行吗？合上盖子、用电池时也不睡眠；屏幕仍可以关。合盖的笔记本放在包里也不会睡眠，可能发热。这会改电源设置，需要输入一次 Mac 密码。"
   如果我说是：运行 thoth always-on。如果它说输入密码需要终端，就告诉我打开"终端" app，在那里运行同一条命令，然后等我回答。
   Windows：问我："让这台电脑一直保持运行吗？接电源和用电池时都不睡眠；屏幕仍可以关。WSL 会一直运行，重启以后也是。这会改电源设置，并添加一个 Windows 计划任务，可能需要管理员权限。"
   如果我说是：运行 thoth always-on。如果它给出要由管理员运行的命令，就把命令给我看，告诉我用管理员身份在 PowerShell 里运行，然后等我回答。如果我说否，告诉我："Windows 睡眠或 WSL 停止时，Thoth 也会停止。"
   macOS 和 Windows：然后运行 thoth always-on --status。告诉我："以后要撤销，运行：thoth always-on --undo"
   Linux：Thoth 在 Linux 上不改电源设置。问我："注销和重启以后也让 Thoth 继续运行吗？这会添加 systemd 用户服务。"
   如果我说是：运行 thoth services install。如果它给出一条 sudo 命令，就请我运行，等我回答。告诉我："请确认这台电脑不会睡眠（在系统设置里）。以后要撤销，运行：thoth services uninstall"
6. 自检。运行：thoth doctor --json
   每一项 "ok": false 的检查，照它的 "fix" 字段去做（需要我的时候先问我），然后再运行 thoth doctor --json。
7. 用最多 7 行短句向我报告：系统、角色、名字、云端 brain、常开（开、关或跳过），以及每一项没通过的检查和它的修法。
不要打印、保存或复述任何 token、代码或 owner 链接。`;
}

/** The prompt in one language. With hub, join and name: the ready-made prompt for one helper. */
export function setupPrompt(lang: PromptLang, o: PromptOptions): string {
  const filled = [o.hub, o.join, o.name].every((v) => (v ?? '') !== '');
  return lang === 'zh' ? zh(o, filled) : en(o, filled);
}

/** The main panel's prompt for a new computer (Add a Computer, cloud brain), or '' for a strange reply.
 * One text for every system: the prompt itself says what differs on Windows and Linux. */
export function panelPrompt(r: { hub: string; code: string; device: string }): string {
  // the code and the name come from the brain's reply: only the expected forms go into a prompt
  if (!/^[A-Za-z\d-]{4,64}$/.test(r.code) || !/^[a-z\d][a-z\d-]{0,30}$/.test(r.device)) return '';
  return setupPrompt('en', { install: PANEL_INSTALL, hub: r.hub, join: r.code, name: r.device });
}
