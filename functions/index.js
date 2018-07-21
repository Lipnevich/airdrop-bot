const functions = require('firebase-functions');
const TelegramBot = require('node-telegram-bot-api');

const token = functions.config().bot.token;
const url = functions.config().bot.hook;
const bot = new TelegramBot(token, {webHook: { port: 443 }, polling: false});

exports.hook = functions.https.onRequest((request, response) => {
    console.log('Request body: ' + JSON.stringify(request.body));

    let message = request.body.message;
    let chat = message.chat;

    if (chat) {
        if (chat.type == "private") {
            bot.sendMessage(chat.id, 'Hei-ho! Please add me to your group in order to start!')
        }
    }

    response.status(201).send('Done!');
});

exports.init = functions.https.onRequest((request, response) => {
    bot.setWebHook(`${url}/bot${token}`);
    response.status(201).send('Web hook added!');
});


