const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const TelegramBot = require('node-telegram-bot-api');
const botToken = functions.config().bot.token;
const botWebhook = functions.config().bot.hook;
const bot = new TelegramBot(botToken, {webHook: { port: 443 }, polling: false});

const WavesAPI = require('@waves/waves-api');
const addressForRewards = functions.config().wallet.address;
const salt = functions.config().wallet.salt;
const decimals = 10000000;
const fee = 0.01 * decimals;
const rewardAmount = 0.01;
const VERSION = '0.13';
const Waves = WavesAPI.create(WavesAPI.TESTNET_CONFIG);

exports.hook = functions.https.onRequest((request, response) => {
    console.log('Request body: ' + JSON.stringify(request.body));

    let process = { message : request.body.message, response : response };

    try {
        startBot(process);
    } catch(error) {
        console.log(error);
        botSay(process);
    }
});

function botSay(process, messageToUser) {
    let intro = 'Dear ' + process.message.from.first_name;
    if(messageToUser) {
        messageToUser = intro + ', ' + messageToUser;
        console.log(messageToUser);
    } else {
        messageToUser = intro + ', internal bot error happens. Please contact @Lipnevich for solving it';
    }
    bot.sendMessage(process.message.chat.id, messageToUser);
    process.response.status(201).send(VERSION);
}

function shouldProcess(message) {
    return message && !message.is_bot && message.chat && (message.chat.type == 'group'
        || message.chat.type == 'private' || message.chat.type == 'supergroup') && message.entities && message.entities[0]
        && message.entities[0].type == 'bot_command';
}

function startBot(process) {
    if(!shouldProcess(process.message)) {
        console.log('Ignore message');
        return process.response.status(201).send(VERSION);
    }

    if (process.message.chat.type == "private") {
        console.log('Private chat message', process.message.text);
        return botSay(process, 'please add me to your group in order to start');
    }

    bot.getChatMember(process.message.chat.id, process.message.from.id).then(member => {
        if(member.status == "creator") {
            processAdmin(process);
        } else {
            processMember(process);
        }
    });
}

function processAdmin(process) {
    let words = process.message.text.split(' ');
    switch(words[0]) {
        case '/start' :
        case '/help' :
        case '/start@AirDropSmartRewarderBot' :
        case '/help@AirDropSmartRewarderBot' :
            return botSay(process, 'I will send reward to each new member in this group '
                + process.message.chat.title + '. There is a fixed fee per each reward in '
                + rewardAmount + ' WAVES. In order to start please set reward with command: '
                + '/reward AMOUNT TOKEN_NAME');
        case '/reward' :
        case '/reward@AirDropSmartRewarderBot' :
            return setupReward(process);
        case '/withdraw' :
        case '/withdraw@AirDropSmartRewarderBot' :
            return withdraw(process);
        default : return botSay(process);
    }
}

function processMember(process) {
    let words = process.message.text.split(' ');
    switch(words[0]) {
        case '/start' :
        case '/help' :
        case '/start@AirDropSmartRewarderBot' :
        case '/help@AirDropSmartRewarderBot' :
            return botSay(process, 'you may get your reward for joining this group with command /withdraw ADDRESS');
        case '/reward' :
        case '/reward@AirDropSmartRewarderBot' :
        case '/withdraw' :
        case '/withdraw@AirDropSmartRewarderBot' :
            return rewardMember(process);
        default : return botSay(process);
    }
}

function rewardMember(process) {
    let words = process.message.text.split(' ');
    if(words.length != 2) {
        return botSay(process, 'please check your command. For example /withdraw ADDRESS'
            + ' where ADDRESS is your Waves address');
    }
    let address = words[1];
    let ref = admin.database().ref('chats').child('' + process.message.chat.id);
    ref.once('value').then(snapshot => {
        let chat = snapshot.val();
        if(!chat || !chat.amount || !chat.token) {
            console.log('Reward was not set up');
            return botSay(process, 'reward was not set up yet. Please contact this group owner for details');
        }
        if(!chat.members) {
            chat.members = {}
        }
        let memberId = '' + process.message.from.id;
        if(chat.members[memberId]) {
            console.log('Member was rewarded already');
            return botSay(process, 'reward ' + chat.amount + ' ' + chat.token
                + ' was already sent to address ' + chat.members[memberId]);
        }

        let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, salt));
        Waves.API.Node.addresses.balanceDetails(wallet.address).then(balanceDetails => {
            if(balanceDetails.available < (rewardAmount * decimals)) {
                console.log('Low balance for reward');
                return botSay(process, 'there is not enough money for reward. Please contact this group owner for details');
            }

            const rewardData = {
                recipient: address,
                assetId: chat.token,
                amount: chat.amount * decimals,
                feeAssetId: 'WAVES',
                fee: fee,
                attachment: '',
                timestamp: Date.now()
            };

            Waves.API.Node.transactions.broadcast('transfer', rewardData, wallet.keyPair).then(response => {
                console.log('Reward have been sent', rewardData);

                ref.child('members').child(memberId).set(address);

                const botFeeData = {
                                recipient: addressForRewards,
                                assetId: 'WAVES',
                                amount: ((rewardAmount * decimals) - (fee * 2)),
                                feeAssetId: 'WAVES',
                                fee: fee,
                                attachment: '',
                                timestamp: Date.now()
                };
                let messageToUser = 'reward ' + chat.amount + ' ' + chat.token + ' was sent to address ' + address;
                Waves.API.Node.transactions.broadcast('transfer', botFeeData, wallet.keyPair).then(response => {
                    console.log('Bot fee have been sent', botFeeData);
                    return botSay(process, messageToUser);
                }).catch(error => {
                    console.error('Error during bot fee sending', error);
                    return botSay(process, messageToUser);
                });
            }).catch(error => {
                console.error('Error during reward sending', error);
                return botSay(process, 'Waves blockchain error happens');
            });
        });
    });
}

function setupReward(process) {
    let words = process.message.text.split(' ');
    if(words.length != 3) {
        console.log('Incorrect setup reward', words);
        return botSay(process, 'please check your command. For example for rewarding each new member with 5.5 Noxbox tokens type: /reward 5.5 9PVyxDPUjauYafvq83JTXvHQ8nPnxwKA7siUFcqthCDJ');
    }
    let amount = words[1];
    if(Number.isNaN(amount)) {
        console.log('Incorrect amount in setup reward', words);
        return botSay(process, 'please check your command. Seems like amount that your entered is not a number. For example correct numbers are 1500, 200.3, 0.04');
    }
    let token = words[2];

    let ref = admin.database().ref('chats').child('' + process.message.chat.id);
    ref.once('value').then(snapshot => {
        let chat = snapshot.val();
        if(!chat) {
            chat = { seed : Waves.Seed.create().encrypt(salt) };
        }

        chat.amount = amount;
        chat.token = token;
        ref.set(chat);
        console.log('Chat settings persisted. ', JSON.stringify(chat));

        let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, salt));
        return botSay(process, 'reward was successfully set! I will be able to start rewarding process as soon as you send at least ' + amount + ' ' + token + ' and ' + rewardAmount + ' WAVES to ' + wallet.address + '. You will be able to withdraw all your funds any time you want with command /withdraw AMOUNT TOKEN_NAME ADDRESS');
    });
}

function withdraw(process) {
    let words = process.message.text.split(' ');
    if(words.length != 4) {
        console.log('Incorrect withdraw command', words);
        return botSay(process, 'please check your command. For example for withdrawing 5.5 Noxbox tokens type: /withdraw 5.5 9PVyxDPUjauYafvq83JTXvHQ8nPnxwKA7siUFcqthCDJ ADDRESS');
    }
    let amount = words[1];
    if(Number.isNaN(amount)) {
        console.log('Incorrect amount in setup reward', words);
        return botSay(process, 'please check your command. Seems like amount that your entered is not a number. For example correct numbers are 1500, 200.3, 0.04');
    }
    let token = words[2];
    let address = words[3];
    admin.database().ref('chats').child('' + process.message.chat.id).once('value').then(snapshot => {
        console.log(JSON.stringify(snapshot));
        let chat = snapshot.val();
        if(!chat) {
            console.log('Attempt to withdraw without setup reward');
            return botSay(process, 'nothing to withdraw, please set up reward first');
        }

        let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, salt));
        const withdrawData = {
            recipient: address,
            assetId: token,
            amount: amount * decimals,
            feeAssetId: 'WAVES',
            fee: fee,
            attachment: '',
            timestamp: Date.now()
        };
        let messageToUser = 'withdraw ' + chat.amount + ' ' + chat.token + ' was sent to address ' + address;
        Waves.API.Node.transactions.broadcast('transfer', withdrawData, wallet.keyPair).then(response => {
            console.log('Withdraw processed', withdrawData);
            return botSay(process, messageToUser);
        }).catch(error => {
            console.log(error);
            return botSay(process, 'Error during withdraw, please check your balance on ' + wallet.address);
        });
    });
}

exports.setWebhook = functions.https.onRequest((request, response) => {
    bot.setWebHook(botWebhook + '/bot' + botToken);
    response.status(201).send('Webhook was added! ' + version);
});


