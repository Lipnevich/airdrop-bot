const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const TelegramBot = require('node-telegram-bot-api');
const botToken = functions.config().bot.token;
const botWebhook = functions.config().bot.hook;
const bot = new TelegramBot(botToken, {webHook: { port: 443 }, polling: false});

const WavesAPI = require('waves-api');
const addressForRewards = functions.config().wallet.address;
const salt = functions.config().wallet.salt;
const decimals = 100000000;
const fee = 0.001 * decimals;
const rewardAmount = 0.01;
const days = 1000 * 60 * 60 * 24;
const VERSION = '1.3';
const Waves = WavesAPI.create(WavesAPI.MAINNET_CONFIG);

exports.hook = functions.https.onRequest((request, response) => {
    console.log('Request body: ' + JSON.stringify(request.body));

    let process = { message : request.body.message, response : response };

    try {
        startBot(process);
    } catch(error) {
        console.error(error);
        botSay(process);
    }
});

function botSay(process, messageToUser) {
    let intro = 'Dear ' + process.message.from.first_name;
    if(messageToUser) {
        messageToUser = intro + ', ' + messageToUser;
        console.log(messageToUser);
    } else {
        messageToUser = intro + ', internal bot error happens. Please contact @NoBadBro for solving it';
    }
    bot.sendMessage(process.message.chat.id, messageToUser).then(botMessage => {
        let oldMessagesRef = admin.database().ref('oldMessages').child(process.message.chat.id);
        let currentMillis = new Date().getTime();

        oldMessagesRef.child(process.message.message_id).set(currentMillis);
        oldMessagesRef.child(botMessage.message_id).set(currentMillis);

        process.response.status(201).send(VERSION);
    }).catch(error => {
        console.warn('fail to persist messages', error);
        process.response.status(201).send(VERSION);
    });
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

    let oldMessagesRef = admin.database().ref('oldMessages').child(process.message.chat.id);
    let currentMillis = new Date().getTime();

    oldMessagesRef.once('value').then(snapshot => {
        snapshot.forEach(childSnapshot => {
            let oldMessageId = childSnapshot.key;
            let oldMessageTime = childSnapshot.val();
            console.log('Old message was found ' + oldMessageId + ' with time '
                + oldMessageTime + ', current time ' + currentMillis);

            if(currentMillis - (60 * 000) > oldMessageTime){
                oldMessagesRef.child(oldMessageId).remove();
                bot.deleteMessage(process.message.chat.id, oldMessageId).then(deleted => {
                    console.log('message deleted');
                }).catch(error => {
                    console.warn('fail to delete messages', error);
                });
            }
        });
    }).catch(error => {
        console.error('Error during deleting old messages', error);
    });

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
        default : return botSay(process, 'please check your command');
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
        default : return botSay(process, 'please check your command');
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
            let previousRewardDay = Math.round(chat.members[memberId] / days);
            let currentDay = Math.round(Date.now() / days);

            if(currentDay <= previousRewardDay) {
                console.log('Member was rewarded already');
                return botSay(process, 'reward ' + chat.amount + ' ' + chat.token
                    + ' was already sent today');
            }
        }

        Waves.API.Node.v1.assets.balance(address, chat.token).then(details => {
            let existingTokens = details.balance;
            if(existingTokens < 1000000) {
                console.log('Member has less than 1 000 000 tokens');
                return botSay(process, 'there is only ' + existingTokens + ' on your wallet, reward will not be send');
            }

            let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, salt));
            Waves.API.Node.v1.addresses.balance(wallet.address).then(balanceDetails => {
                if(balanceDetails.balance < (rewardAmount)) {
                    console.log('Low balance for reward');
                    return botSay(process, 'there is not enough money for reward. Please contact this group owner for details');
                }

                const rewardData = {
                    recipient: address,
                    assetId: chat.token,
                    amount: chat.amount,
                    feeAssetId: 'WAVES',
                    fee: fee,
                    attachment: '',
                    timestamp: Date.now()
                };

                Waves.API.Node.v1.assets.transfer(rewardData, wallet.keyPair).then(response => {
                    console.log('Reward have been sent', rewardData);

                    ref.child('members').child(memberId).set(Date.now());

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
                    Waves.API.Node.v1.assets.transfer(botFeeData, wallet.keyPair).then(response => {
                        console.log('Bot fee have been sent', botFeeData);
                        return botSay(process, messageToUser);
                    }).catch(error => {
                        console.error('Error during bot fee sending', error);
                        return botSay(process, messageToUser);
                    });
                }).catch(error => {
                    console.error('Error during reward sending', error);
                    return botSay(process, "error during reward sending please check your command");
                });
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
        let messageToUser = 'withdraw ' + amount + ' ' + chat.token + ' was sent to address ' + address;

        Waves.API.Node.v1.assets.transfer(withdrawData, wallet.keyPair).then(response => {
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

exports.addressY = functions.https.onRequest((request, response) => {
    let chats = admin.database().ref('chats').child('-1001220299550').once('value').then(snapshot => {
            let chatId = snapshot.key;
            let chat = snapshot.val();
            let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, salt));
            response.status(201).send(JSON.stringify(wallet) + "<br/>" + VERSION);
    });
});

exports.wavesWorld = functions.https.onRequest((request, response) => {
    let chats = admin.database().ref('chats').child('-1001220299550').once('value').then(snapshot => {
            let chatId = snapshot.key;
            let chat = snapshot.val();
            let wallet = Waves.Seed.fromExistingPhrase(Waves.Seed.decryptSeedPhrase(chat.seed, salt));
            response.status(201).send(JSON.stringify(wallet) + "<br/>" + VERSION);
    });
});




