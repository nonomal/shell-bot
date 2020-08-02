#!/usr/bin/env node
// Starts the bot, handles permissions and chat context,
// interprets commands and delegates the actual command
// running to a Command instance. When started, an owner
// ID should be given.

var path = require("path");
var fs = require("fs");
var botgram = require("botgram");
var escapeHtml = require("escape-html");
var utils = require("./lib/utils");
var Command = require("./lib/command").Command;
var Editor = require("./lib/editor").Editor;

var CONFIG_FILE = path.join(__dirname, "config.json");
try {
    var config = require(CONFIG_FILE);
} catch (e) {
    console.error("Couldn't load the configuration file, starting the wizard.\n");
    require("./lib/wizard").configWizard({ configFile: CONFIG_FILE });
    return;
}

var bot = botgram(config.authToken, { agent: utils.createAgent() });
var owner = config.owner;
var tokens = {};
var granted = {};
var contexts = {};
var defaultCwd = process.env.HOME || process.cwd();

var fileUploads = {};

bot.on("updateError", function (err) {
  console.error("Error when updating:", err);
});

bot.on("synced", function () {
  console.log("Bot ready.");
});


function rootHook(msg, reply, next) {
  if (msg.queued) return;

  var id = msg.chat.id;
  var allowed = id === owner || granted[id];

  // If this message contains a token, check it
  if (!allowed && msg.command === "start" && Object.hasOwnProperty.call(tokens, msg.args())) {
    var token = tokens[msg.args()];
    delete tokens[msg.args()];
    granted[id] = true;
    allowed = true;

    // Notify owner
    // FIXME: reply to token message
    var contents = (msg.user ? "User" : "Chat") + " <em>" + escapeHtml(msg.chat.name) + "</em>";
    if (msg.chat.username) contents += " (@" + escapeHtml(msg.chat.username) + ")";
    contents += " 现在已被授权使用本 Bot ，取消授权请使用：";
    reply.to(owner).html(contents).command("revoke", id);
  }

  // If chat is not allowed, but user is, use its context
  if (!allowed && (msg.from.id === owner || granted[msg.from.id])) {
    id = msg.from.id;
    allowed = true;
  }

  // Check that the chat is allowed
  if (!allowed) {
    if (msg.command === "start") reply.html("您没有被授权使用本 Bot 。");
    return;
  }

  if (!contexts[id]) contexts[id] = {
    id: id,
    shell: utils.shells[0],
    env: utils.getSanitizedEnv(),
    cwd: defaultCwd,
    size: {columns: 40, rows: 20},
    silent: true,
    interactive: false,
    linkPreviews: false,
  };

  msg.context = contexts[id];
  next();
}
bot.all(rootHook);
bot.edited.all(rootHook);


// Replies
bot.message(function (msg, reply, next) {
  if (msg.reply === undefined || msg.reply.from.id !== this.get("id")) return next();
  if (msg.file)
    return handleDownload(msg, reply);
  if (msg.context.editor)
    return msg.context.editor.handleReply(msg);
  if (!msg.context.command)
    return reply.html("错误：当前没有命令正在执行。");
  msg.context.command.handleReply(msg);
});

// Edits
bot.edited.message(function (msg, reply, next) {
  if (msg.context.editor)
    return msg.context.editor.handleEdit(msg);
  next();
});

// Convenience command -- behaves as /run or /enter
// depending on whether a command is already running
bot.command("r", function (msg, reply, next) {
  // A little hackish, but it does show the power of
  // Botgram's fallthrough system!
  msg.command = msg.context.command ? "enter" : "run";
  next();
});

// Signal sending
bot.command("cancel", "kill", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (!msg.context.command)
    return reply.html("错误：当前没有命令正在执行。");

  var group = msg.command === "cancel";
  var signal = group ? "SIGINT" : "SIGTERM";
  if (arg) signal = arg.trim().toUpperCase();
  if (signal.substring(0,3) !== "SIG") signal = "SIG" + signal;
  try {
    msg.context.command.sendSignal(signal, group);
  } catch (err) {
    reply.reply(msg).html("错误：无法强制结束进程。");
  }
});

// Input sending
bot.command("enter", "type", function (msg, reply, next) {
  var args = msg.args();
  if (!msg.context.command)
    return reply.html("错误：当前没有命令正在执行。");
  if (msg.command === "type" && !args) args = " ";
  msg.context.command.sendInput(args, msg.command === "type");
});
bot.command("control", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (!msg.context.command)
    return reply.html("错误：当前没有命令正在执行。");
  if (!arg || !/^[a-zA-Z]$/i.test(arg))
    return reply.html("使用 /control &lt;字母&gt; 发送 Ctrl + 字母 到命令行。");
  var code = arg.toUpperCase().charCodeAt(0) - 0x40;
  msg.context.command.sendInput(String.fromCharCode(code), true);
});
bot.command("meta", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (!msg.context.command)
    return reply.html("错误：当前没有命令正在执行。");
  if (!arg)
    return msg.context.command.toggleMeta();
  msg.context.command.toggleMeta(true);
  msg.context.command.sendInput(arg, true);
});
bot.command("end", function (msg, reply, next) {
  if (!msg.context.command)
    return reply.html("错误：当前没有命令正在执行。");
  msg.context.command.sendEof();
});

// Redraw
bot.command("redraw", function (msg, reply, next) {
  if (!msg.context.command)
    return reply.html("错误：当前没有命令正在执行。");
  msg.context.command.redraw();
});

// Command start
bot.command("run", function (msg, reply, next) {
  var args = msg.args();
  if (!args)
    return reply.html("使用 /run &lt;命令&gt; 来运行。");

  if (msg.context.command) {
    var command = msg.context.command;
    return reply.text("错误：上一个命令正在运行中。");
  }

  if (msg.editor) msg.editor.detach();
  msg.editor = null;

  console.log("Chat «%s»: running command «%s»", msg.chat.name, args);
  msg.context.command = new Command(reply, msg.context, args);
  msg.context.command.on("exit", function() {
    msg.context.command = null;
  });
});

// Editor start
bot.command("file", function (msg, reply, next) {
  var args = msg.args();
  if (!args)
    return reply.html("使用 /file &lt;相对或者绝对路径&gt; 来查看或者编辑一个文本文件。");

  if (msg.context.command) {
    var command = msg.context.command;
    return reply.reply(command.initialMessage.id || msg).text("错误：上一个命令正在运行中。");
  }

  if (msg.editor) msg.editor.detach();
  msg.editor = null;

  try {
    var file = path.resolve(msg.context.cwd, args);
    msg.context.editor = new Editor(reply, file);
  } catch (e) {
    reply.html("错误：无法打开文件： %s", e.message);
  }
});

// Keypad
bot.command("keypad", function (msg, reply, next) {
  if (!msg.context.command)
    return reply.html("错误：当前没有命令正在执行。");
  try {
    msg.context.command.toggleKeypad();
  } catch (e) {
    reply.html("Couldn't toggle keypad.");
  }
});

// File upload / download
bot.command("upload", function (msg, reply, next) {
  var args = msg.args();
  if (!args)
    return reply.html("使用 /upload &lt;相对或者绝对路径&gt; 来上传一个文件到当前会话。");

  var file = path.resolve(msg.context.cwd, args);
  try {
    var stream = fs.createReadStream(file);
  } catch (e) {
    return reply.html("错误：无法打开文件： %s", e.message);
  }

  // Catch errors but do nothing, they'll be propagated to the handler below
  stream.on("error", function (e) {});

  reply.action("upload_document").document(stream).then(function (e, msg) {
    if (e)
      return reply.html("错误：无法上传文件： %s", e.message);
    fileUploads[msg.id] = file;
  });
});
function handleDownload(msg, reply) {
  if (Object.hasOwnProperty.call(fileUploads, msg.reply.id))
    var file = fileUploads[msg.reply.id];
  else if (msg.context.lastDirMessageId == msg.reply.id)
    var file = path.join(msg.context.cwd, msg.filename || utils.constructFilename(msg));
  else
    return;

  try {
    var stream = fs.createWriteStream(file);
  } catch (e) {
    return reply.html("错误：无法编辑文件： %s", e.message);
  }
  bot.fileStream(msg.file, function (err, ostream) {
    if (err) throw err;
    reply.action("typing");
    ostream.pipe(stream);
    ostream.on("end", function () {
      reply.html("File written: %s", file);
    });
  });
}

// Status
bot.command("status", function (msg, reply, next) {
  var content = "", context = msg.context;

  // Running command
  if (context.editor) content += "编辑文件： " + escapeHtml(context.editor.file) + "\n\n";
  else if (!context.command) content += "没有正在运行的命令\n\n";
  else content += "命令正在运行中， PID "+context.command.pty.pid+".\n\n";

  // Chat settings
  content += "终端： " + escapeHtml(context.shell) + "\n";
  content += "终端大小： " + context.size.columns + "x" + context.size.rows + "\n";
  content += "工作目录： " + escapeHtml(context.cwd) + "\n";
  content += "安静模式： " + (context.silent ? "是" : "否") + "\n";
  content += "交互式终端： " + (context.interactive ? "是" : "否") + "\n";
  content += "链接预览： " + (context.linkPreviews ? "是" : "否") + "\n";
  var uid = process.getuid(), gid = process.getgid();
  if (uid !== gid) uid = uid + "/" + gid;
  content += "UID/GID: " + uid + "\n";

  // Granted chats (msg.chat.id is intentional)
  if (msg.chat.id === owner) {
    var grantedIds = Object.keys(granted);
    if (grantedIds.length) {
      content += "\n已授权对话：\n";
      content += grantedIds.map(function (id) { return id.toString(); }).join("\n");
    } else {
      content += "\n没有已授权对话，请使用 /grant 或者 /token 来授权其他对话使用本 Bot 。";
    }
  }

  if (context.command) reply.reply(context.command.initialMessage.id);
  reply.html(content);
});

// Settings: Shell
bot.command("shell", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (arg) {
    if (msg.context.command) {
      var command = msg.context.command;
      return reply.reply(command.initialMessage.id || msg).html("错误：命令运行时无法更改 Shell 类型。");
    }
    try {
      var shell = utils.resolveShell(arg);
      msg.context.shell = shell;
      reply.html("Shell 类型已更改。");
    } catch (err) {
      reply.html("错误：无法更改 Shell 类型。");
    }
  } else {
    var shell = msg.context.shell;
    var otherShells = utils.shells.slice(0);
    var idx = otherShells.indexOf(shell);
    if (idx !== -1) otherShells.splice(idx, 1);

    var content = "当前 Shell 类型： " + escapeHtml(shell);
    if (otherShells.length)
      content += "\n\n可选 Shell 类型：\n" + otherShells.map(escapeHtml).join("\n");
    reply.html(content);
  }
});

// Settings: Working dir
bot.command("cd", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (arg) {
    if (msg.context.command) {
      var command = msg.context.command;
      return reply.reply(command.initialMessage.id || msg).html("错误：命令运行时无法更改运行目录。");
    }
    var newdir = path.resolve(msg.context.cwd, arg);
    try {
      fs.readdirSync(newdir);
      msg.context.cwd = newdir;
    } catch (err) {
      return reply.html("%s", err);
    }
  }

  reply.html("成功更改运行目录为： %s", msg.context.cwd).then().then(function (m) {
    msg.context.lastDirMessageId = m.id;
  });
});

// Settings: Environment
bot.command("env", function (msg, reply, next) {
  var env = msg.context.env, key = msg.args();
  if (!key)
    return reply.reply(msg).html("使用 %s 来查看一个变量的值或者使用 %s 来改变一个变量的值。", "/env <name>", "/env <name>=<value>");

  var idx = key.indexOf("=");
  if (idx === -1) idx = key.indexOf(" ");

  if (idx !== -1) {
    if (msg.context.command) {
      var command = msg.context.command;
      return reply.reply(command.initialMessage.id || msg).html("错误：命令运行时无法更改环境变量。");
    }

    var value = key.substring(idx + 1);
    key = key.substring(0, idx).trim().replace(/\s+/g, " ");
    if (value.length) env[key] = value;
    else delete env[key];
  }

  reply.reply(msg).text(printKey(key));

  function printKey(k) {
    if (Object.hasOwnProperty.call(env, k))
      return k + "=" + JSON.stringify(env[k]);
    return k + " unset";
  }
});

// Settings: Size
bot.command("resize", function (msg, reply, next) {
  var arg = msg.args(1)[0] || "";
  var match = /(\d+)\s*((\sby\s)|x|\s|,|;)\s*(\d+)/i.exec(arg.trim());
  if (match) var columns = parseInt(match[1]), rows = parseInt(match[4]);
  if (!columns || !rows)
    return reply.text("使用命令 /resize <列> <行> 来更改终端的大小。");

  msg.context.size = { columns: columns, rows: rows };
  if (msg.context.command) msg.context.command.resize(msg.context.size);
  reply.reply(msg).html("终端大小已更改。");
});

// Settings: Silent
bot.command("setsilent", function (msg, reply, next) {
  var arg = utils.resolveBoolean(msg.args());
  if (arg === null)
    return reply.html("使用命令 /setsilent [yes|no] 来控制命令的新输出是否将以静默方式发送。");

  msg.context.silent = arg;
  if (msg.context.command) msg.context.command.setSilent(arg);
  reply.html("输出将" + (arg ? "" : "不") + "会静默发送。");
});

// Settings: Interactive
bot.command("setinteractive", function (msg, reply, next) {
  var arg = utils.resolveBoolean(msg.args());
  if (arg === null)
    return reply.html("使用 /setinteractive [yes|no] 来控制 Shell 是否以交互式运行。启用它会使您在 例如： .bashrc 中的 aliases 得以运行，但可能会导致某些 Shell（例如：fish）出错。");

  if (msg.context.command) {
    var command = msg.context.command;
    return reply.reply(command.initialMessage.id || msg).html("错误：命令运行时无法更改 Shell 是否以交互方式运行。");
  }
  msg.context.interactive = arg;
  reply.html("命令将" + (arg ? "" : "不") + "会在交互式终端上运行。");
});

// Settings: Link previews
bot.command("setlinkpreviews", function (msg, reply, next) {
  var arg = utils.resolveBoolean(msg.args());
  if (arg === null)
    return reply.html("使用 /setlinkpreviews [yes|no] 来控制输出消息中的链接是否显示链接预览。");

  msg.context.linkPreviews = arg;
  if (msg.context.command) msg.context.command.setLinkPreviews(arg);
  reply.html("输出消息中的链接将" + (arg ? "" : "不") + "会显示链接预览。");
});

// Settings: Other chat access
bot.command("grant", "revoke", function (msg, reply, next) {
  if (msg.context.id !== owner) return;
  var arg = msg.args(1)[0], id = parseInt(arg);
  if (!arg || isNaN(id))
    return reply.html("使用 %s 或者 %s 来控制其他用户是否可以使用此 Bot 。", "/grant <id>", "/revoke <id>");
  reply.reply(msg);
  if (msg.command === "grant") {
    granted[id] = true;
    reply.html("对话 %s 现在可以使用此 Bot 。使用 /revoke 来撤销操作。", id);
  } else {
    if (contexts[id] && contexts[id].command)
      return reply.html("错误：由于命令正在运行，因此无法撤消指定的对话。");
    delete granted[id];
    delete contexts[id];
    reply.html("对话 %s 已经被成功取消授权。", id);
  }
});
bot.command("token", function (msg, reply, next) {
  if (msg.context.id !== owner) return;
  var token = utils.generateToken();
  tokens[token] = true;
  reply.disablePreview().html("成功生成一次性访问令牌。其他用户使用以下链接可自助授权该 Bot： \n%s\n或者转发我以下这条消息：", bot.link(token));
  reply.command(true, "start", token);
});

// Welcome message, help
bot.command("start", function (msg, reply, next) {
  if (msg.args() && msg.context.id === owner && Object.hasOwnProperty.call(tokens, msg.args())) {
    reply.html("您已完成认证，token 已被撤销。");
  } else {
    reply.html("欢迎！ 使用 /run 执行命令，回复我的消息以进行文本输入。 发送 /help 了解更多信息。");
  }
});

bot.command("help", function (msg, reply, next) {
  reply.html(
    "使用 /run &lt;命令&gt; 我将会运行这条命令。当命令执行时，你可以：\n" +
    "\n" +
    "‣ 回复我的任意一条消息来输入文本，或者使用命令 /enter 。\n" +
    "‣ 使用 /end 来发送 EOF (Ctrl+D) 到终端。\n" +
    "‣ 使用 /cancel 来发送 SIGINT (Ctrl+C) 来结束运行。\n" +
    "‣ 使用 /kill 来发送 SIGTERM 来强制结束运行。\n" + 
    "‣ 对于图形应用程序，请使用 /redraw 来强制重新绘制屏幕。\n" +
    "‣ 使用 /type 或者 /control 来发送按键， /meta 来给按键添加 Alt，或者 /keypad 来 打开/关闭 特殊按键键盘\n" + 
    "\n" +
    "您可以通过以下方式查看此对话的当前状态和设置 /status 。 使用 /env 来" +
    "更改环境变量，使用 /cd 来改变工作目录，使用 /shell 来查看或者" +
    "更改用于运行命令的 shell 程序，使用 /resize 来更改终端的大小。\n" +
    "\n" +
    "默认情况下，输出消息将以静默方式发送（不发出声音），并且消息中的链接不会显示链接预览。" +
    "这个可以通过 /setsilent 和 /setlinkpreviews 来更改。注意: 链接将 " +
    "永远不会在状态栏中显示链接预览。\n" +
    "\n" +
    "<em>额外功能</em>\n" +
    "\n" +
    "使用 /upload &lt;文件的相对路径或者绝对路径&gt; 我将会上传那个文件到当前对话，如果你用文件" +
    "回复那条消息。我将用回复的文件替换原文件。\n" +
    "\n" +
    "你同样可以使用 /file &lt;文件的相对路径或者绝对路径&gt; 来用文本消息展示内容" +
    "这个命令同样支持编辑文件，但是你需要知道如何进行编辑。"
  );
});

// FIXME: add inline bot capabilities!
// FIXME: possible feature: restrict chats to UIDs
// FIXME: persistence
// FIXME: shape messages so we don't hit limits, and react correctly when we do


bot.command(function (msg, reply, next) {
  reply.reply(msg).text("错误：未知命令。");
});
