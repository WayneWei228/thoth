// The setup prompt: the text a person pastes into Claude Code on a new Mac, so Claude Code installs
// Thoth, joins the cloud brain, keeps the Mac on and checks the result (multi-device plan, PR 8).
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
    ? `2. Use these values. Do not ask me for them:
   role: helper; cloud brain: ${o.hub ?? ''}; name: ${o.name ?? ''}; one-time code: ${o.join ?? ''} (it works once, for 15 minutes).`
    : `2. Ask me two questions, then wait for my answers:
   a. "Is this Mac a helper (a spare Mac that runs tasks for your main computer) or your main computer?" The default is helper.
   b. "What is the address of your cloud brain (https://...)? Thoth on your main computer shows it under File > Set Up Devices…"
   For a main computer, also ask me for my owner link (ccbrain://...). It is a secret: put it only in the command and do not repeat it to me. Tell me first that this chat is saved on this Mac (in Claude Code's history), so the link is stored there too.
   You may also ask me for a short name for this Mac (small letters, digits and -). Without one, Thoth uses the host name.`;
  const join = filled
    ? `3. Join. Run: thoth setup --role helper --hub ${o.hub ?? ''} --join ${o.join ?? ''} --name ${o.name ?? ''}`
    : `3. Join. Run one of these:
   helper: thoth setup --role helper --hub <address> [--name <name>]
   main:   thoth setup --role main --connect '<owner link>' [--name <name>]`;
  return `Set up this Mac as a computer of my Thoth (https://thoth.build). This is macOS only: on another system, stop and tell me.
Run each step yourself in this terminal and read its output. When a step needs me, ask me and wait for my answer. Never use sleep or a loop to wait.

1. Install. Run: thoth doctor --json
   If the command is not found or does not print JSON, install Thoth: curl -fsSL ${o.install} | bash
   Then run thoth doctor --json again. If thoth is still not found, use ~/.local/bin/thoth.
${values}
${join}
   - Exit code 0: done. Go to step 4.
   - Exit code 6: it waits for my Approve. Tell me: "In Thoth on your main Mac, open File > Set Up Devices… and choose Approve for this Mac." Then stop and wait for my answer. When I say it is done, run the same command again.
   - Another exit code: show me the FAILED line. If it names a thoth command, run that command, then the same setup command again. Ask me before anything else.
4. Keep it on (helper only; skip this step for a main computer). Ask me: "Keep this Mac on all the time? It then stays on even with the lid closed and on battery; the display may still turn off. A closed laptop in a bag stays awake and can get warm. This changes its power settings and needs your Mac password once." Do nothing before I answer.
   If I say yes: run thoth always-on. If it says it needs a terminal for the password, tell me to open the Terminal app and run the same command there, and wait for my answer.
   Then run: thoth always-on --status
   Tell me: "To undo it later, run: thoth always-on --undo"
5. Check. Run: thoth doctor --json
   For each check with "ok": false, do what its "fix" field says (ask me first when the fix needs me), then run thoth doctor --json again.
6. Report to me in at most 6 short lines: the role, the name, the cloud brain, always-on (on, off or skipped), and each check that is not ok with its fix.
Never print, save or repeat a token, a code or an owner link.`;
}

function zh(o: PromptOptions, filled: boolean): string {
  const values = filled
    ? `2. 用下面的值，不要再问我：
   角色：helper；云端 brain：${o.hub ?? ''}；名字：${o.name ?? ''}；一次性代码：${o.join ?? ''}（只能用一次，15 分钟内有效）。`
    : `2. 问我两个问题，等我回答：
   a. "这台 Mac 是备用机（替主力机跑任务的空闲 Mac），还是你的主力机？" 默认是备用机。
   b. "你的云端 brain 地址是什么（https://...）？主力机上的 Thoth 在 File > Set Up Devices… 里显示它。"
   如果是主力机，还要问我的 owner 链接（ccbrain://...）。它是密钥：只放在命令里，不要向我复述。先告诉我：这段对话会保存在这台 Mac 上（Claude Code 的历史记录里），所以链接也会存在那里。
   也可以问我这台 Mac 的短名字（小写字母、数字和 -）。不给的话，Thoth 用主机名。`;
  const join = filled
    ? `3. 加入。运行：thoth setup --role helper --hub ${o.hub ?? ''} --join ${o.join ?? ''} --name ${o.name ?? ''}`
    : `3. 加入。运行其中一条：
   备用机：thoth setup --role helper --hub <地址> [--name <名字>]
   主力机：thoth setup --role main --connect '<owner 链接>' [--name <名字>]`;
  return `把这台 Mac 配置成我的 Thoth（https://thoth.build）里的一台电脑。只支持 macOS：如果是别的系统，停下来告诉我。
每一步都由你在这个终端里运行，并读它的输出。需要我的时候，问我，等我回答。不要用 sleep 或循环来等待。

1. 安装。运行：thoth doctor --json
   如果找不到这个命令，或者它没有输出 JSON，就安装 Thoth：curl -fsSL ${o.install} | bash
   然后再运行 thoth doctor --json。如果还是找不到 thoth，用 ~/.local/bin/thoth。
${values}
${join}
   - 退出码 0：完成。进入第 4 步。
   - 退出码 6：在等我点 Approve。告诉我："请在主力机的 Thoth 里打开 File > Set Up Devices…，为这台 Mac 选择 Approve。" 然后停下，等我回答。我说好了以后，再运行同一条命令。
   - 其他退出码：把 FAILED 那一行给我看。如果它给出一条 thoth 命令，就运行它，再运行同一条 setup 命令。别的事先问我。
4. 保持常开（只对备用机；主力机跳过这一步）。问我："让这台 Mac 一直保持运行吗？合上盖子、用电池时也不睡眠；屏幕仍可以关。合盖的笔记本放在包里也不会睡眠，可能发热。这会改电源设置，需要输入一次 Mac 密码。" 我回答之前什么都不要做。
   如果我说是：运行 thoth always-on。如果它说输入密码需要终端，就告诉我打开"终端" app，在那里运行同一条命令，然后等我回答。
   然后运行：thoth always-on --status
   告诉我："以后要撤销，运行：thoth always-on --undo"
5. 自检。运行：thoth doctor --json
   每一项 "ok": false 的检查，照它的 "fix" 字段去做（需要我的时候先问我），然后再运行 thoth doctor --json。
6. 用最多 6 行短句向我报告：角色、名字、云端 brain、常开（开、关或跳过），以及每一项没通过的检查和它的修法。
不要打印、保存或复述任何 token、代码或 owner 链接。`;
}

/** The prompt in one language. With hub, join and name: the ready-made prompt for one helper. */
export function setupPrompt(lang: PromptLang, o: PromptOptions): string {
  const filled = [o.hub, o.join, o.name].every((v) => (v ?? '') !== '');
  return lang === 'zh' ? zh(o, filled) : en(o, filled);
}

/** The main panel's prompt for a new computer (Add a Computer, cloud brain): macOS only, else ''. */
export function panelPrompt(os: string, r: { hub: string; code: string; device: string }): string {
  // the code and the name come from the brain's reply: only the expected forms go into a prompt
  if (os !== 'macos' || !/^[A-Za-z\d-]{4,64}$/.test(r.code) || !/^[a-z\d][a-z\d-]{0,30}$/.test(r.device)) return '';
  return setupPrompt('en', { install: PANEL_INSTALL, hub: r.hub, join: r.code, name: r.device });
}
