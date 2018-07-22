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
const fee = 100000;
const rewardAmount = 0.01;
const version = '0.12';
const Waves = WavesAPI.create(WavesAPI.TESTNET_CONFIG);

exports.hook = functions.https.onRequest((request, response) => {
    console.log('Request body: ' + JSON.stringify(request.body));

    let message = request.body.message;
    if (message && message.chat && message.entities && message.entities[0] && message.entities[0].type == 'bot_command') {
        if (message.chat.type == "private") {
            return bot.sendMessage(message.chat.id, 'Hey-ho! Please add me to your group in order to start!')
        }

        bot.getChatMember(message.chat.id, message.from.id).then(member => {
            if (member.status == "creator"){
                processOwner(message);
            } else {
                processMember(message);
            }
        });
    }

    response.status(201).send('Done!' + version);
});

function processOwner(message) {
    let words = message.text.split(' ');
    switch(words[0]) {
        case '/start' :
        case '/help' :
        case '/start@AirDropSmartRewarderBot' :
        case '/help@AirDropSmartRewarderBot' :
            bot.sendMessage(message.chat.id, `Hey-ho, ${message.from.first_name}! I will send reward to each new member in this ${message.chat.type} ${message.chat.title}. There is a fixed fee per each reward in ${rewardAmount} WAVES. In order to start please set reward with command: /reward AMOUNT TOKEN_NAME`); break;
        case '/reward' :
        case '/reward@AirDropSmartRewarderBot' :
            setupReward(message); break;
        case '/withdraw'
        case '/withdraw@AirDropSmartRewarderBot' :
            withdraw(message); break;
    }
}

function processMember(message) {
    let words = message.text.split(' ');
    switch(words[0]) {
        case '/start' :
        case '/help' :
        case '/start@AirDropSmartRewarderBot' :
        case '/help@AirDropSmartRewarderBot' :
            bot.sendMessage(message.chat.id, `Hey-ho, dear ${message.from.first_name}! You may get your reward for joining this ${message.chat.type} ${message.chat.title} with command /withdraw ADDRESS`);
        case '/reward' :
        case '/reward@AirDropSmartRewarderBot' :
        case '/withdraw' :
        case '/withdraw@AirDropSmartRewarderBot' :
            rewardMember(message);
            break;
    }
}

function rewardMember(message) {
    let words = message.text.split(' ');
    if(words.length != 2) {
        return bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, please check your command. For example /withdraw ADDRESS where ADDRESS is your Waves address`);
    }
    let address = words[1];
    let ref = admin.database().ref('chats').child('' + message.chat.id);
    ref.once('value').then(snapshot => {
        let chat = snapshot.val();
        if(!chat || !chat.amount || !chat.token) {
            return bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, reward was not set yet. Please contact this ${message.chat.type} owner for details`);
        }
        if(!chat.members) {
            chat.members = {}
        }
        let memberId = '' + message.from.id;
        if(chat.members[memberId]) {
            return bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, reward was already sent to address ${chat.members[memberId]}`);
        }

        let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, salt));
        Waves.API.Node.addresses.balanceDetails(wallet.address).then(balanceDetails => {
            console.log(balanceDetails);
            if(balanceDetails.available < (rewardAmount * decimals)) {
                return bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, there is not enough money for reward. Please contact this ${message.chat.type} owner for details`);
            }

            const transferData = {
                recipient: address,
                assetId: chat.token,
                amount: amount,
                feeAssetId: 'WAVES',
                fee: fee,
                attachment: '',
                timestamp: Date.now()
            };


            Waves.API.Node.transactions.broadcast('transfer', transferData, wallet.keyPair).then(response => {
                ref.child('members').child(memberId).set(address);
                bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, reward was sent to address ${address}`);

                const transferData = {
                                recipient: addressForRewards,
                                assetId: 'WAVES',
                                amount: ((rewardAmount * decimals) - (fee * 2)),
                                feeAssetId: 'WAVES',
                                fee: fee,
                                attachment: '',
                                timestamp: Date.now()
                };

                Waves.API.Node.transactions.broadcast('transfer', transferData, wallet.keyPair).then(response => {
                    console.log('Reward achieved')
                }).catch(e => {
                    console.error(e.message);
                });
            }).catch(e => {
                console.error(e.message);
                return bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, an error appears during rewarding ${e.message}`);
            });
        });
    });
}

function withdraw(message) {
    admin.database().ref('chats').child('' + message.chat.id).once('value').then(snapshot => {
        console.log(JSON.stringify(snapshot));
        let chat = snapshot.val();

        let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, salt));
        Waves.API.Node.addresses.balanceDetails(wallet.address).then(balanceDetails => {
            console.log(balanceDetails);
            return bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, your wallet ${balanceDetails}`);
        });
    });
}

function setupReward(message) {
    let words = message.text.split(' ');
    if(words.length != 3) {
        return bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, please check your command. For example for rewarding each new member with 5.5 BestTokenEver tokens type: /reward 5.5 BestTokenEver`);
    }
    let amount = words[1];
    if(Number.isNaN(amount)) {
        return bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, please check your command. Seems like amount that your entered is not a number. For example correct numbers are 1500, 200.3, 0.04`);
    }
    let token = words[2];
    if(!Number.isNaN(token)) {
        return bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, please check your command. Seems like token name that your entered is a number. For example WAVES, 9PVyxDPUjauYafvq83JTXvHQ8nPnxwKA7siUFcqthCDJ, BTC`);
    }

    let ref = admin.database().ref('chats').child('' + message.chat.id);
    ref.once('value').then(snapshot => {
        console.log(JSON.stringify(snapshot));
        let chat = snapshot.val();
        if(!chat) {
            chat = { seed : Waves.Seed.create().encrypt(salt) };
        }

        chat.amount = amount;
        chat.token = token;
        ref.set(chat);

        let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, salt));
        bot.sendMessage(message.chat.id, `Dear ${message.from.first_name}, reward was successfully set! I will be able to start rewarding process as soon as you send at least ${amount} ${token} and ${rewardAmount} WAVES to ${wallet.address}. You will be able to withdraw all your funds any time you want with command /withdraw ADDRESS`);
    });
}

exports.setWebhook = functions.https.onRequest((request, response) => {
    bot.setWebHook(`${botWebhook}/bot${botToken}`);
    response.status(201).send('Webhook was added! ' + version);
});


