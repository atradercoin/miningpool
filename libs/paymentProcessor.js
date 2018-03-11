var fs = require('fs');

var redis = require('redis');
var async = require('async');

var Stratum = require('merged-pooler');
var util = require('merged-pooler/lib/util.js');


module.exports = function(logger){

    var poolConfigs = JSON.parse(process.env.pools);

    var enabledPools = [];
    
    process.on('message', function(message) {
        switch(message.type){
            case 'reloadpool':
                if (message.coin) {
                    var messageCoin = message.coin.toLowerCase();
                    var poolTarget = Object.keys(poolConfigs).filter(function(p){
                        return p.toLowerCase() === messageCoin;
                    })[0];
                    poolConfigs  = JSON.parse(message.pools);
                    if (addPoolIfEnabled(messageCoin))
                        setupPools([messageCoin]);
                }
                break;
        }
    });

    var addPoolIfEnabled = function(c) {
        var poolOptions = poolConfigs[c];
        if (poolOptions.paymentProcessing && poolOptions.paymentProcessing.enabled) {
            enabledPools.push(c);
            return true;
        } else {
            return false;
        }
    }

    var setupPools = function(enPools) {
        async.filter(enPools, function(coin, callback){
            SetupForPool(logger, poolConfigs[coin], function(setupResults){
                callback(setupResults);
            });
        }, function(coins){
            coins.forEach(function(coin){

                var poolOptions = poolConfigs[coin];
                var processingConfig = poolOptions.paymentProcessing;
                var logSystem = 'Payments';
                var logComponent = coin;
                var feePercent = poolOptions.feePercent;

                logger.debug(logSystem, logComponent, 'Payment processing setup to run every '
                    + processingConfig.paymentInterval + ' second(s) with daemon ('
                    + processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port
                    + ') and redis (' + poolOptions.redis.host + ':' + poolOptions.redis.port + ')');

            });
        });
    }

    Object.keys(poolConfigs).forEach(function(coin) {
        addPoolIfEnabled(coin);
    });

    setupPools(enabledPools);

};

function SetupForPool(logger, poolOptions, setupFinished){


    var coin = poolOptions.coin.name;
    var coinSymbol = poolOptions.coin.symbol;
    var processingConfig = poolOptions.paymentProcessing;

    var logSystem = 'Payments';
    var logComponent = coin;

    var daemon = new Stratum.daemon.interface([processingConfig.daemon], function(severity, message){
        logger[severity](logSystem, logComponent, message);
    });
    var redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);
	redisClient.auth(poolOptions.redis.password);
	redisClient.select(poolOptions.redis.db);

    var magnitude;
    var minPaymentSatoshis;
    var coinPrecision;

    var paymentInterval;

    async.parallel([
        function(callback){
            daemon.cmd('validateaddress', [poolOptions.address], function(result) {
                if (result.error){
                    logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                    callback(true);
                }
                else if (!result.response || !result.response.ismine) {
                    logger.fatal(logSystem, logComponent,
                            'Daemon does not own pool address - payment processing can not be done with this daemon, '
                            + JSON.stringify(result.response));
                    callback(true);
                }
                else{
                    callback()
                }
            }, true);
        },
        function(callback){
            daemon.cmd('getbalance', [], function(result){
                if (result.error){
                    callback(true);
                    return;
                }
                try {
                    var d = result.data.split('result":')[1].split(',')[0].split('.')[1];
                    magnitude = parseInt('10' + new Array(d.length).join('0'));
                    minPaymentSatoshis = parseInt(processingConfig.minimumPayment * magnitude);
                    coinPrecision = magnitude.toString().length - 1;
                    callback();
                }
                catch(e){
                    logger.error(logSystem, logComponent, 'Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: ' + result.data);
                    callback(true);
                }

            }, true, true);
        }
    ], function(err){
        if (err){
            setupFinished(false);
            return;
        }
        paymentInterval = setInterval(function(){
            try {
                processPayments();
            } catch(e){
                throw e;
            }
        }, processingConfig.paymentInterval * 1000);
        setTimeout(processPayments, 100);
        setupFinished(true);
    });




    var satoshisToCoins = function(satoshis){
        return parseFloat((satoshis / magnitude).toFixed(coinPrecision));
    };

    var coinsToSatoshies = function(coins){
        return coins * magnitude;
    };

    function roundDown(number, decimals) {
        decimals = decimals || 0;
        return ( Math.floor( number * Math.pow(10, decimals) ) / Math.pow(10, decimals) );
    }


    /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    var processPayments = function(){

        var startPaymentProcess = Date.now();

        var timeSpentRPC = 0;
        var timeSpentRedis = 0;

        var startTimeRedis;
        var startTimeRPC;

        var startRedisTimer = function(){ startTimeRedis = Date.now() };
        var endRedisTimer = function(){ timeSpentRedis += Date.now() - startTimeRedis };

        var startRPCTimer = function(){ startTimeRPC = Date.now(); };
        var endRPCTimer = function(){ timeSpentRPC += Date.now() - startTimeRedis };


        function getwalletbalance()
        {

            var rpcCommand, rpcArgs;
            rpcCommand = 'getbalance';

            daemon.cmd(rpcCommand, rpcArgs, function(results)
            {
                logger.info(logSystem, logComponent,'results'+ results.length);

                for (var i = 0; i < results.length; i++)
                {
                    var result = results[i];
                    if (result.error)
                    {
                        logger.error(logSystem, logComponent,'error');
                        return;
                    }
                    else if (result.response === 'rejected') {
                        logger.error(logSystem, logComponent,'rejected');
                        return;
                    }
                    else
                    {
                        logger.info(logSystem, logComponent,'Wallet Balance '+result.response);
                        return result.response;
                    }
                }
            });
        }


        async.waterfall([

            /* Call redis to get an array of rounds - which are coinbase transactions and block heights from submitted
               blocks. */
            function(callback){

                startRedisTimer();
                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocksPending']
                ]).exec(function(error, results){
                    endRedisTimer();

                    if (error){
                        logger.error(logSystem, logComponent, 'Could not get blocks from redis ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var workers = {};
                    for (var w in results[0]){
                        workers[w] = {balance: coinsToSatoshies(parseFloat(results[0][w]))};
                    }

                    var rounds = results[1].map(function(r){
                        var details = r.split(':');
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
                            serialized: r
                        };
                    });

                    callback(null, workers, rounds);
                });
            },

            /* Does a batch rpc call to daemon with all the transaction hashes to see if they are confirmed yet.
               It also adds the block reward amount to the round object - which the daemon gives also gives us. */
            function(workers, rounds, callback){

                var batchRPCcommand = rounds.map(function(r){
                    return ['gettransaction', [r.txHash]];
                });

                batchRPCcommand.push(['getaccount', [poolOptions.address]]);

                startRPCTimer();
                daemon.batchCmd(batchRPCcommand, function(error, txDetails)
                {
                    endRPCTimer();

                    if (error || !txDetails){
                        logger.error(logSystem, logComponent, 'Check finished - daemon rpc error with batch gettransactions '
                            + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var addressAccount;

                    txDetails.forEach(function(tx, i){

                        if (i === txDetails.length - 1){
                            addressAccount = tx.result;
                            return;
                        }

                        var round = rounds[i];

                        if (tx.error && tx.error.code === -5){
                            logger.error(logSystem, logComponent, 'Daemon reports invalid transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (tx.error || tx.result == null){
                            logger.error(logSystem, logComponent, 'Odd error with gettransaction ' + round.txHash + ' '
                                + JSON.stringify(tx));
                            return;
                        }
                        else if (tx.result.details == null || (tx.result.details && tx.result.details.length === 0)){
                            logger.debug(logSystem, logComponent, 'Daemon reports no details for transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }

                        var generationTx = tx.result.details.filter(function(tx){
                            return tx.address === poolOptions.address;
                        })[0];


                        if (!generationTx && tx.result.details.length === 1){
                            generationTx = tx.result.details[0];
                        }

                        if (!generationTx){
                            logger.error(logSystem, logComponent, 'Missing output details to pool address for transaction '
                                + round.txHash);
                            return;
                        }

                        round.category = generationTx.category;
                        if (round.category === 'generate') {
                            round.reward = generationTx.amount || generationTx.value;
                        }

                    });

                    var canDeleteShares = function(r){
                        for (var i = 0; i < rounds.length; i++){
                            var compareR = rounds[i];
                            if ((compareR.height === r.height)
                                && (compareR.category !== 'kicked')
                                && (compareR.category !== 'orphan')
                                && (compareR.serialized !== r.serialized)){
                                return false;
                            }
                        }
                        return true;
                    };



                    //Filter out all rounds that are immature (not confirmed or orphaned yet)
                    rounds = rounds.filter(function(r)
                    {
                        switch (r.category) {
                            case 'orphan':
                            case 'kicked':
                                r.canDeleteShares = canDeleteShares(r);
                            case 'generate':
                                return true;
                            case 'immature':
                            default:
                                return false;
                        }
                    });

                    callback(null, workers, rounds, addressAccount);

                });
            },



            /* Does a batch redis call to get shares contributed to each round. Then calculates the reward
               amount owned to each miner for each round. */
            function(workers, rounds, addressAccount, callback){


                logger.debug(logSystem, logComponent, 'Calculating Shares');

                var shareLookups = rounds.map(function(r){
                    return ['hgetall', coin + ':shares:round' + r.height]
                });

                startRedisTimer();
                redisClient.multi(shareLookups).exec(function(error, allWorkerShares){
                    endRedisTimer();

                    if (error){
                        callback('Check finished - redis error with multi get rounds share');
                        return;
                    }
                    var totalPayout =0;
                    rounds.forEach(function(round, i)
                    {
                        var workerShares = allWorkerShares[i];

                        if (!workerShares){
                            logger.info(logSystem, logComponent, 'No worker shares for round: ');
                            return;
                        }

                        switch (round.category)
                        {
                            case 'kicked':
                            case 'orphan':
                                round.workerShares = workerShares;
                                break;

                            case 'generate':
                                /* We found a confirmed block! Now get the reward for it and calculate how much
                                   we owe each miner based on the shares they submitted during that block round. */
                                var reward = parseInt(round.reward * magnitude);

                                var totalShares = Object.keys(workerShares).reduce(function(p, c){
                                    return p + parseFloat(workerShares[c])
                                }, 0);

                                for (var workerAddress in workerShares)
                                {
                                    var percent = parseFloat(workerShares[workerAddress]) / totalShares;
                                    var workerRewardTotal = Math.floor(reward * percent);
                                    var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                    worker.reward = (worker.reward || 0) + workerRewardTotal;
                                    logger.info(logSystem, logComponent, 'Worker Reward for round ' + workerAddress + " " + satoshisToCoins(workerRewardTotal));
                                    totalPayout += workerRewardTotal;
                                }
                                break;
                        }
                    });
                    logger.info(logSystem, logComponent, 'Total Payout Due' + satoshisToCoins( totalPayout));

                    callback(null, workers, rounds, addressAccount);
                });
            },





            /* Calculate if any payments are ready to be sent and trigger them sending
             Get balance different for each address and pass it along as object of latest balances such as
             {worker1: balance1, worker2, balance2}
             when deciding the sent balance, it the difference should be -1*amount they had in db,
             if not sending the balance, the differnce should be +(the amount they earned this round)
             */
            function(workers, rounds, addressAccount, callback)
            {
                logger.debug(logSystem, logComponent, 'Calculating Payments');
                var trySend = function (withholdPercent)
                {
                    withholdPercent = 0.01;
                    logger.debug(logSystem, logComponent, 'Withhold%' + withholdPercent*100);
                    var test = Object.keys(workers);
                    var addressAmounts = {};
                    var totalSent = 0;
                    var totalHold = 0;

                    //test.forEach(function(w)
                    //{
                    //   var worker = workers[w];
                    //    var address = worker.address = (worker.address || getProperAddress(w));
                    //    var balance = worker.balance || 0;
                    //    logger.debug(logSystem, logComponent, 'Worker Address ' + address + ' Balance ' + satoshisToCoins(balance));
                    //});

                    test.forEach(function(w)
                    {
                        daemon.cmd('validateaddress', [w], function (results)
                        {
                            var validWorkerAddress = results[0].response.isvalid;
                            if (!results[0].response.address) {

                                logger.debug(logSystem, logComponent, 'Validate returned false');
                                var worker = workers[w];
                                worker.balance = worker.balance || 0;
                                worker.reward = worker.reward || 0;
                                var toSend = (worker.balance + worker.reward);// * (1 - withholdPercent);
                                worker.balanceChange = Math.max(toSend - worker.balance, 0);
                                worker.sent = 0;
                                worker.actualsent = 0;

                            }
                            else
                            {
                                var worker = workers[w];
                                var address = worker.address = (worker.address || getProperAddress(w));
                                worker.balance = worker.balance || 0;
                                worker.reward = worker.reward || 0;
                                var toSend = (worker.balance + worker.reward);
                                var toHold = (worker.balance + worker.reward)* (withholdPercent);
                                var toSendMinusWitholding = (worker.balance + worker.reward) * (1 - withholdPercent);

                                if (toSend >= minPaymentSatoshis)
                                {
                                    var address = worker.address = (worker.address || getProperAddress(w));
                                    worker.sent = satoshisToCoins(toSend);
                                    worker.actualsent = satoshisToCoins(toSendMinusWitholding);;
                                    addressAmounts[address] = satoshisToCoins(toSendMinusWitholding);
                                    worker.balanceChange = Math.min(worker.balance, toSend) * -1;
                                    //worker.balanceChange = toSend * -1;
                                    totalSent += toSend - toHold;
                                    totalHold += toHold;
                                    logger.debug(logSystem, logComponent, 'Address ' + address +
                                                 ' Balance ' + satoshisToCoins(worker.balance) +
                                                 ' Reward ' + satoshisToCoins(worker.reward) +
                                                 'ToSend ' + satoshisToCoins(toSend) +
                                                 'ToHold ' + satoshisToCoins(toHold) +
                                                 'SendMinusWith ' + satoshisToCoins(toSendMinusWitholding) +
                                                 'BalanceChange' + satoshisToCoins(worker.balanceChange)
                                     );


                                }
                                else
                                {
                                    logger.debug(logSystem, logComponent, 'Address ' + address +
                                                 ' Balance ' + satoshisToCoins(worker.balance)
                                    );

                                    worker.balanceChange = worker.reward;// Math.max(toSend - worker.balance, 0);
                                    worker.sent = 0;

                                }
                            }
                            //logger.debug(logSystem, logComponent, 'Send total of ' + satoshisToCoins(totalSent) + ' Holding ' + satoshisToCoins(totalHold) + ' Total ' + satoshisToCoins(total));


                        });

                    });

                    setTimeout(function()
                    {
                        if (addressAccount.length ==0)
                            logger.info(logSystem, logComponent, 'No payments for round due');
                        else  {
                            logger.info(logSystem, logComponent, 'addressAccount:' + addressAccount);
                            logger.info(logSystem, logComponent, 'addressAmounts:' + addressAmounts);
                        }

                        if (Object.keys(addressAmounts).length === 0){

                            callback(null, workers, rounds);
                            return;
                        }

                        daemon.cmd('sendmany', [addressAccount || '', addressAmounts], function (result)
                        {
                            //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                            if (result.error && result.error.code === -6) {
                                logger.error(logSystem, logComponent, 'Not enough funds to cover the tx fees for sending out payments, Cancelled');
                                //var higherPercent = withholdPercent + 0.01;
                                //trySend(higherPercent);
                            }
                            if (result.error && result.error.code === -6) {
                                var higherPercent = withholdPercent + 0.01;
                                logger.error(logSystem, logComponent, 'Not enough funds to cover the tx fees for sending out payments, Cancelled');
                                //logger.error(logSystem, logComponent, 'Not enough funds to cover the tx fees for sending out payments, decreasing rewards by '
                                //    + (higherPercent * 100) + '% and retrying');
                                //trySend(higherPercent);
                            }
                            else if (result.error && result.error.code === -5) {
                                logger.error(logSystem, logComponent, 'Error trying to send payments with RPC sendmany ' + JSON.stringify(result.error));
                            }
                            else if (result.error) {
                                logger.error(logSystem, logComponent, 'Error trying to send payments with RPC sendmany '
                                    + JSON.stringify(result.error));
                                callback(true);
                            }
                            else {
                                logger.info(logSystem, logComponent, 'Sent out a total of ' + (totalSent / magnitude)
                                    + ' to ' + Object.keys(addressAmounts).length + ' workers');
                                //if (withholdPercent > 0) {
                                //    logger.error(logSystem, logComponent, 'Had to withhold ' + (withholdPercent * 100)
                                //        + '% of reward from miners to cover transaction fees. '
                                //        + 'Fund pool wallet with coins to prevent this from happening');
                                //}
                                callback(null, workers, rounds);
                            }
                        }, true, true);
                    }, 10000); // This is the time span -  ensure that it fits within your payment rota!

                };
                trySend(0);

            },
            function(workers, rounds, callback)
            {
                var totalPaid = 0;

                var balanceUpdateCommands = [];
                var workerPayoutsCommand = [];
                var updatePaymentsCommands = [];

                for (var w in workers) {
                    var worker = workers[w];
                    if (worker.balanceChange !== 0)
                    {
                        balanceUpdateCommands.push([
                            'hincrbyfloat',
                            coin + ':balances',
                            w,
                            satoshisToCoins(worker.balanceChange)
                        ]);
                    }
                    if (worker.sent !== 0)
                    {
                        workerPayoutsCommand.push(['hincrbyfloat', coin + ':payouts', w, worker.actualsent]);// worker.sent]);
                        totalPaid += worker.actualsent;
                        logger.info(logSystem, logComponent, workerPayoutsCommand);


                        updatePaymentsCommands.push(['hset',
                                                     coin + ':Payouts' + ":" + w,
                                                     Math.floor(Date.now() / 1000),
                                                     worker.actualsent]); // update balance payments


                    }
                }

                var updateBlockStatCommands = [];
                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];

                var moveSharesToCurrent = function(r){
                    var workerShares = r.workerShares;
                    Object.keys(workerShares).forEach(function(worker){
                    orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent',
                        +worker, workerShares[worker]]);
                        });  
                };

                rounds.forEach(function(r){
                    updateBlockStatCommands.push(['hset', 'Allblocks', coinSymbol +"-"+ r.height, r.serialized + ":" + r.category]); // hashgoal addition for update block stats for all coins
                });

                rounds.forEach(function(r){
                        switch(r.category){
                            case 'kicked':
                                movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksOrphaned', r.serialized]);
                            case 'orphan':
                                movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksOrphaned', r.serialized]);
                                if (r.canDeleteShares){
                                    moveSharesToCurrent(r);
                                    roundsToDelete.push(coin + ':shares:round' + r.height);
                                }
                                return;
                            case 'generate':
                                movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksConfirmed', r.serialized]);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                                return;
                        }
                });

                var finalRedisCommands = [];

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (balanceUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

                if (workerPayoutsCommand.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);

                if (updateBlockStatCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(updateBlockStatCommands);

                if (updatePaymentsCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(updatePaymentsCommands);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(['del'].concat(roundsToDelete));

                if (totalPaid !== 0)
                    finalRedisCommands.push(['hincrbyfloat', coin + ':stats', 'totalPaid', totalPaid]);


                if (finalRedisCommands.length === 0){
                    callback();
                    return;
                }

                startRedisTimer();
                redisClient.multi(finalRedisCommands).exec(function(error, results){
                    endRedisTimer();
                    if (error){
                        clearInterval(paymentInterval);
                        logger.info("REDIS COMMANDS" + finalRedisCommands);
                        logger.error(logSystem, logComponent,
                                'Payments sent but could not update redis. ' + JSON.stringify(error)
                                + ' Disabling payment processing to prevent possible double-payouts. The redis commands in '
                                + coin + '_finalRedisCommands.txt must be ran manually');
                        fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), function(err){
                            logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                        });
                    }
                    callback();
                });
            }

        ], function(){

            var paymentProcessTime = Date.now() - startPaymentProcess;
            logger.debug(logSystem, logComponent, 'Finished interval - time spent: '
                + paymentProcessTime + 'ms total, ' + timeSpentRedis + 'ms redis, '
                + timeSpentRPC + 'ms daemon RPC');

        });
    };


    var getProperAddress = function(address){
        if (address.length === 40){
            return util.addressFromEx(poolOptions.address, address);
        }
        else return address;
    };


}

/*

REDIS COMMANDS
smove,mohcoin:blocksPending,mohcoin:blocksConfirmed,89e25bec963bff3a959370eafe4e718730b15d9012116ca5bf0d0d4d2482527c:8f49a8722f82508d6da2f07556c0e0ee182ffea88c0342b6c6e588da687b2a8a:3846:SP6Lkju4wmhZMyf6ndYWeh1DyqJ7VGU1V3:1511972645:5000000000,
smove,mohcoin:blocksPending,mohcoin:blocksConfirmed,0a9ae55a6490561a21fd31287f59f7479ce0fae86b00013002b677ba6fb67f57:a29da970baf250a551080ae66c828f03168b3e953a3b2aca9bccb13cfd8487d2:3847:SP6Lkju4wmhZMyf6ndYWeh1DyqJ7VGU1V3:1511972747:5000000000,
hincrbyfloat,mohcoin:balances,SfXDaHe66t5U8dPrXaE3B1xXFu8srsNQVm,-88.92283125,
hincrbyfloat,mohcoin:balances,SP6Lkju4wmhZMyf6ndYWeh1DyqJ7VGU1V3,-42.49530767,
hincrbyfloat,mohcoin:payouts,SfXDaHe66t5U8dPrXaE3B1xXFu8srsNQVm,111.4336768,
hincrbyfloat,mohcoin:payouts,SP6Lkju4wmhZMyf6ndYWeh1DyqJ7VGU1V3,119.9844621,
hset,Allblocks,MOH-3846,89e25bec963bff3a959370eafe4e718730b15d9012116ca5bf0d0d4d2482527c:8f49a8722f82508d6da2f07556c0e0ee182ffea88c0342b6c6e588da687b2a8a:3846:SP6Lkju4wmhZMyf6ndYWeh1DyqJ7VGU1V3:1511972645:5000000000:generate,
hset,Allblocks,MOH-3847,0a9ae55a6490561a21fd31287f59f7479ce0fae86b00013002b677ba6fb67f57:a29da970baf250a551080ae66c828f03168b3e953a3b2aca9bccb13cfd8487d2:3847:SP6Lkju4wmhZMyf6ndYWeh1DyqJ7VGU1V3:1511972747:5000000000:generate,
hset,mohcoin:workerpayouts,SfXDaHe66t5U8dPrXaE3B1xXFu8srsNQVm:1511976540:111.4336768,
hset,mohcoin:workerpayouts,SP6Lkju4wmhZMyf6ndYWeh1DyqJ7VGU1V3:1511976540:119.9844621,
del,mohcoin:shares:round3846,mohcoin:shares:round3847,
hincrbyfloat,mohcoin:stats,totalPaid,231.4181389
*/
