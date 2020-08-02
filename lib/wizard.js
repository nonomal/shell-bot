var readline = require("readline");
var botgram = require("botgram");
var fs = require("fs");
var util = require("util");
var utils = require("./utils");

// Wizard functions

function stepAuthToken(rl, config) {
    return question(rl, "首先，请输入 bot API token: ")
    .then(function (token) {
        token = token.trim();
        //if (!/^\d{5,}:[a-zA-Z0-9_+/-]{20,}$/.test(token))
        //    throw new Error();
        config.authToken = token;
        return createBot(token);
    }).catch(function (err) {
        console.error("错误：输入的 token 无效，请重试。\n%s\n", err);
        return stepAuthToken(rl, config);
    });
}

function stepOwner(rl, config, getNextMessage) {
    console.log("正在等待您向我发送一条消息...");
    return getNextMessage().then(function (msg) {
        var prompt = util.format("您是 %s «%s» (%s) 吗？ [y/n]: ", msg.chat.type, msg.chat.name, msg.chat.id);
        return question(rl, prompt)
        .then(function (answer) {
            console.log();
            answer = answer.trim().toLowerCase();
            if (answer === "y" || answer === "yes")
                config.owner = msg.chat.id;
            else
                return stepOwner(rl, config, getNextMessage);
        });
    });
}

function configWizard(options) {
    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    var config = {};
    var bot = null;

    return Promise.resolve()
    .then(function () {
        return stepAuthToken(rl, config);
    })
    .then(function (bot_) {
        bot = bot_;
        console.log("\n现在，给我发送一条消息，以便我能够读取您的 Telegram ID：\n%s\n", bot.link());
    })
    .then(function () {
        var getNextMessage = getPromiseFactory(bot);
        return stepOwner(rl, config, getNextMessage);
    })
    .then(function () {
        console.log("准备已就绪，正在写入配置文件...");
        var contents = JSON.stringify(config, null, 4) + "\n";
        return writeFile(options.configFile, contents);
    })

    .catch(function (err) {
        console.error("错误：配置向导已崩溃：\n%s", err.stack);
        process.exit(1);
    })
    .then(function () {
        rl.close();
        if (bot) bot.stop();
        process.exit(0);
    });
}

// Promise utilities

function question(interface, query) {
    return new Promise(function (resolve, reject) {
        interface.question(query, resolve);
    });
}

function writeFile(file, contents) {
    return new Promise(function (resolve, reject) {
        fs.writeFile(file, contents, "utf-8", function (err) {
            if (err) reject(err);
            else resolve();
        });
    });
}

function createBot(token) {
    return new Promise(function (resolve, reject) {
        var bot = botgram(token, { agent: utils.createAgent() });
        bot.on("error", function (err) {
            bot.stop();
            reject(err);
        });
        bot.on("ready", resolve.bind(this, bot));
    });
}

function getPromiseFactory(bot) {
    var resolveCbs = [];
    bot.message(function (msg, reply, next) {
        if (!msg.queued) {
            resolveCbs.forEach(function (resolve) {
                resolve(msg);
            });
            resolveCbs = [];
        }
        next();
    });
    return function () {
        return new Promise(function (resolve, reject) {
            resolveCbs.push(resolve);
        });
    };
}



exports.configWizard = configWizard;
