'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const TelegramBot = require('node-telegram-bot-api');
const BOT_TOKEN = functions.config().bot.token;
const BOT_WEBHOOK = functions.config().bot.hook;
const bot = new TelegramBot(BOT_TOKEN, {webHook: { port: 443 }, polling: false});

const WavesAPI = require('waves-api');
const ADDRESS_FOR_REWARDS = functions.config().wallet.address;
const SALT = functions.config().wallet.salt;
const DECIMALS = 8;
const FEE = 0.001 * Math.pow(10, DECIMALS);
const REWARD_AMOUNT = 0.01;
const VERSION = ' | Bot version 2.8';

const Waves = WavesAPI.create(WavesAPI.MAINNET_CONFIG);

exports.hook = functions.https.onRequest(async (request, response) => {
    console.log('Request: ' + JSON.stringify(request.body));
    let command = request.body.message;

    try {
        await startBot(command);
    } catch(error) {
        console.error(error);
        await botSay(command, 'error happens. Please check your command', true);
    }

    response.status(201).send(VERSION);
});

async function botSay(command, answer, doNotPersist) {
    answer = 'Dear ' + command.from.first_name + ', ' + answer + VERSION;
    console.log(answer);
    let answerId = (await bot.sendMessage(command.chat.id, answer)).message_id;

    if(!doNotPersist) {
        let messagesRef = admin.database().ref('messages').child(command.chat.id);
        messagesRef.child(command.message_id).set(new Date().getTime());
        messagesRef.child(answerId).set(new Date().getTime());
    }
}

function shouldProcess(message) {
    return message && !message.is_bot && message.chat && (message.chat.type == 'group'
        || message.chat.type == 'private' || message.chat.type == 'supergroup') && message.entities && message.entities[0]
        && message.entities[0].type == 'bot_command';
}

async function startBot(command) {
    removeOutdatedChatMessages(command);

    if(!shouldProcess(command)) {
        console.log('Ignore');
        return;
    }

    if (command.chat.type == "private") {
        console.log('Private chat command', command.text);
        return await botSay(command, 'please add me to your group in order to start', true);
    }

    let isAdmin = (await bot.getChatMember(command.chat.id, command.from.id)).status == "creator";
    if(isAdmin) {
        await processAdmin(command);
    } else {
        await processMember(command);
    }
}

async function removeOutdatedChatMessages(command) {
    let messagesRef = admin.database().ref('messages').child(command.chat.id);
    messagesRef.once('value').then(messages => {
        messages.forEach(message => {
            let oldMessageId = message.key;
            let oldMessageTime = message.val();
            console.log('Old message was found ' + oldMessageId + ' with time '
                + oldMessageTime + ', current time ' + Date.now());

            if(Date.now() > oldMessageTime + 30000){
                messagesRef.child(oldMessageId).remove();
                bot.deleteMessage(command.chat.id, oldMessageId).then(deleted => {
                    console.log('Chat message deleted');
                }).catch(error => {
                    console.warn('Fail to delete chat message');
                });
            }
        });
    }).catch(error => {
        console.error('Error during deleting outdated chat messages', error);
    });
}

async function processAdmin(command) {
    let words = command.text.split(' ');
    switch(words[0]) {
        case '/start' :
        case '/help' :
        case '/start@AirDropSmartRewarderBot' :
        case '/help@AirDropSmartRewarderBot' :
            return await botSay(command, 'I will send reward to each new member in this group '
                + command.chat.title + '. There is a fixed fee per each reward in '
                + REWARD_AMOUNT + ' WAVES. In order to start please set reward with command: '
                + '/reward AMOUNT TOKEN_ID');
        case '/reward' :
        case '/reward@AirDropSmartRewarderBot' :
            return await setupReward(command);
        case '/withdraw' :
        case '/withdraw@AirDropSmartRewarderBot' :
            return await withdraw(command);
        default :
            return await botSay(command, 'please check your command');
    }
}

async function setupReward(command) {
    let words = command.text.split(' ');
    if(words.length != 3) {
        console.log('Incorrect setup reward', words);
        return await botSay(command, 'please check your command. For example for rewarding each new member with 5.5 Noxbox tokens type: /reward 5.5 9PVyxDPUjauYafvq83JTXvHQ8nPnxwKA7siUFcqthCDJ');
    }
    let amount = words[1];
    if(Number.isNaN(amount)) {
        console.log('Incorrect amount in setup reward', words);
        return await botSay(command, 'please check your command. Seems like amount that your entered is not a number. For example correct numbers are 1500, 200.3, 0.04');
    }
    let tokenId = words[2];

    let chatRef = admin.database().ref('chats').child('' + command.chat.id);
    let chat = (await chatRef.once('value')).val();
    if(!chat) {
        chat = { seed : Waves.Seed.create().encrypt(SALT) };
    }

    if(tokenId.toUpperCase() == 'WAVES') {
        chat.decimals = 8;
        chat.token = tokenId.toUpperCase();
        chat.name = chat.token;
    } else {
        let token = await Waves.API.Node.v1.transactions.get(tokenId);
        chat.decimals = token.decimals;
        chat.name = token.name;
        chat.token = tokenId;
    }
    chat.amount = amount;
    if(command.chat.title) {
        chat.chat = command.chat.title;
    }
    let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, SALT));
    chat.address = wallet.address;

    chatRef.set(chat);
    console.log('Chat settings persisted. ', JSON.stringify(chat));

    return await botSay(command, 'reward was successfully set! I will be able to start rewarding process as soon as you send at least ' + amount + ' ' + chat.name + ' and ' + REWARD_AMOUNT + ' WAVES to ' + wallet.address + '. You will be able to withdraw all your funds any time you want with command /withdraw AMOUNT TOKEN_ID TO_ADDRESS');
}

async function withdraw(command) {
    let words = command.text.split(' ');
    if(words.length != 4) {
        console.log('Incorrect withdraw command', words);
        return await botSay(command, 'please check your command. For example for withdrawing 5.5 Noxbox tokens type: /withdraw 5.5 9PVyxDPUjauYafvq83JTXvHQ8nPnxwKA7siUFcqthCDJ TO_ADDRESS');
    }
    let amount = words[1];
    if(Number.isNaN(amount)) {
        console.log('Incorrect amount in setup reward', words);
        return await botSay(command, 'please check your command. Seems like amount that your entered is not a number. For example correct numbers are 1500, 200.3, 0.04');
    }
    let tokenId = words[2];
    let address = words[3];
    let chat = (await admin.database().ref('chats').child('' + command.chat.id).once('value')).val();
    console.log(JSON.stringify(chat));
    if(!chat) {
        console.log('Attempt to withdraw without setup reward');
        return await botSay(command, 'nothing to withdraw, please set up reward first');
    }
    let dec = DECIMALS;
    if(tokenId.toUpperCase() == 'WAVES') {
        tokenId = tokenId.toUpperCase();
    } else if (tokenId == chat.token) {
        dec = chat.decimals;
    } else {
        dec = (await Waves.API.Node.v1.transactions.get(tokenId)).decimals;
    }

    let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, SALT));
    const withdrawData = {
        version: 1,
        recipient: address,
        assetId: tokenId,
        amount: amount * Math.pow(10, dec),
        feeAssetId: 'WAVES',
        fee: FEE,
        attachment: '',
        timestamp: Date.now()
    };
    console.log(JSON.stringify(withdrawData));

    try {
        await Waves.API.Node.v1.assets.transfer(withdrawData, wallet.keyPair);
        console.log('Withdraw processed', withdrawData);
        return await botSay(command, 'withdraw ' + amount + ' ' + tokenId + ' was sent to address ' + address);
    } catch (error) {
        console.log(error);
        return await botSay(command, 'error during withdraw, please check your balance on ' + wallet.address);
    }
}

async function processMember(command) {
    let words = command.text.split(' ');
    switch(words[0]) {
        case '/start' :
        case '/help' :
        case '/start@AirDropSmartRewarderBot' :
        case '/help@AirDropSmartRewarderBot' :
            return await botSay(command, 'you may get your reward for joining this group with command /withdraw ADDRESS');
        case '/reward' :
        case '/reward@AirDropSmartRewarderBot' :
        case '/withdraw' :
        case '/withdraw@AirDropSmartRewarderBot' :
            return await rewardMember(command);
        default :
            return await botSay(command, 'please check your command');
    }
}

async function rewardMember(command) {
    let words = command.text.split(' ');
    if(words.length != 2) {
        return await botSay(command, 'please check your command. For example /withdraw ADDRESS'
            + ' where ADDRESS is your Waves address');
    }
    let address = words[1];
    let chatRef = admin.database().ref('chats').child('' + command.chat.id);
    let chat = (await chatRef.once('value')).val();
    if(!chat || !chat.amount || !chat.token || !chat.decimals) {
        console.log('Reward was not set up');
        return await botSay(command, 'reward was not set up yet. Please contact this group owner for help');
    }
    if(!chat.members) {
        chat.members = {}
    }
    let memberId = '' + command.from.id;
    if(chat.members[memberId]) {
        console.log('Member was rewarded already');
        return await botSay(command, 'reward ' + chat.amount + ' ' + chat.name
            + ' was already sent to address ' + chat.members[memberId]);
    }

    let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, SALT));

    let balanceDetails = await Waves.API.Node.v1.addresses.balance(wallet.address);
    if(balanceDetails.balance < (REWARD_AMOUNT * Math.pow(10, DECIMALS))) {
        console.log('Low balance for reward' + JSON.stringify(balanceDetails));
        return await botSay(command, 'there is not enough money for reward. Please contact this group owner for help');
    }

    const rewardData = {
        version: 1,
        recipient: address,
        assetId: chat.token,
        amount: chat.amount * Math.pow(10, chat.decimals),
        feeAssetId: 'WAVES',
        fee: FEE,
        attachment: '',
        timestamp: Date.now()
    };
    console.log(JSON.stringify(rewardData));

    const botFeeData = {
        version: 1,
        recipient: ADDRESS_FOR_REWARDS,
        assetId: 'WAVES',
        amount: ((REWARD_AMOUNT * Math.pow(10, DECIMALS)) - (FEE * 2)),
        feeAssetId: 'WAVES',
        fee: FEE,
        attachment: '',
        timestamp: Date.now()
    };
    console.log(JSON.stringify(botFeeData));

    try {
        await Waves.API.Node.v1.assets.transfer(rewardData, wallet.keyPair);
        console.log('Reward have been sent', rewardData);
        chatRef.child('members').child(memberId).set(address);

        await Waves.API.Node.v1.assets.transfer(botFeeData, wallet.keyPair);
        console.log('Bot fee have been sent', botFeeData);
        return await botSay(command, 'reward ' + chat.amount + ' ' + chat.name + ' was sent to address ' + address);
    } catch (error) {
        console.error('Error during reward sending', error);
        return await botSay(command, "error during reward sending");
    }
}

exports.setWebhook = functions.https.onRequest((request, response) => {
    bot.setWebHook(BOT_WEBHOOK + '/bot' + BOT_TOKEN);
    response.status(201).send('Webhook was added' + VERSION);
});

