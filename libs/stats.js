var zlib = require('zlib');

var redis = require('redis');
var async = require('async');


var os = require('os');

var algos = require('merged-pooler/lib/algoProperties.js');

// redis callback Ready check failed bypass trick
function rediscreateClient(port, host, pass, db) {
    var client = redis.createClient(port, host);
    client.auth(pass);
    client.select(db);
    return client;
}


module.exports = function(logger, portalConfig, poolConfigs){

    var _this = this;
    var logSystem = 'Stats';
    var redisStats;

    var coinsArray = [];
    var redisClients = [];
    this.statHistory = [];
    this.statPoolHistory = [];
    this.statAlgoHistory = [];
    this.statWorkerHistory = [];
    this.statTest = 'This is a test';

    this.stats = {};
    this.statsString = '';

    setupStatsRedis();
    gatherStatHistory();

    var canDoStats = true;

    Object.keys(poolConfigs).forEach(function(coin){
        coinsArray.push(coin);
        if (!canDoStats) return;

        var poolConfig = poolConfigs[coin];
        var redisConfig = poolConfig.redis;

        for (var i = 0; i < redisClients.length; i++){
            var client = redisClients[i];
            if (client.client.port === redisConfig.port && client.client.host === redisConfig.host){
                logger.debug(logSystem, 'Global', 'coin load [' + coin + ']');
                client.coins.push(coin);
                return;
            }
        }
        redisClients.push({
            coins: [coin],
//          client: redis.createClient(redisConfig.port, redisConfig.host)
//            client: rediscreateClient(redisConfig.port, redisConfig.host, redisConfig.password)
            client: rediscreateClient(redisConfig.port, redisConfig.host, redisConfig.password,  redisConfig.db )
        });
    });

    function setupStatsRedis(){
        redisStats = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);
        // logger.debug(logSystem, 'Global', 'redis.Auth1 "' + portalConfig.redis.password + '"');
        redisStats.auth(portalConfig.redis.password);
        redisStats.select(portalConfig.redis.db);

        redisStats.on('error', function(err){
            logger.error(logSystem, 'Historics', 'Redis for stats had an error ' + JSON.stringify(err));
        });
    }
    
    this.getBlocksStats = function (cback) {
        logger.debug('getBlocksStats');
        var client = redisClients[0].client;
        client.hgetall("Allblocks", function (error, data) {
            if (error) {
                logger.log("error:-" + error);
                cback("");
                return;
            }

            cback(data);

        });
    };

    this.getAllWorkers = function (cback) {

        var client = redisClients[0].client;
        var workers = [];
        var coin ='atradercoin'
        //logger.debug('getAllWorkers');
        async.waterfall([
            function(callback){
                var str = coin + ':payouts';
                client.hgetall(str, function (error, data) {
                    if (error) {
                        logger.log("error getAllWorker err:-" + error);
                        cback();
                        return;
                    }
                    else
                    {
                        workers = data;
                        //logger.debug('getAllWorkers done', str, workers);
                        callback();
                    }
                });
            }
        ], function(err)
        {
            //logger.debug('getAllWorkers end', workers);

            _this.stats.allworkers = workers;
            cback(workers);

        });

    };

    function gatherStatHistory(){
        logger.debug(logSystem, 'Historics', 'gatherStatHistory');

        var retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0).toString();

        redisStats.zrangebyscore(['statHistory', retentionTime, '+inf'], function(err, replies){
            if (err) {
                logger.error(logSystem, 'Historics', 'Error when trying to grab historical stats ' + JSON.stringify(err));
                return;
            }
            for (var i = 0; i < replies.length; i++){
                _this.statHistory.push(JSON.parse(replies[i]));
            }
            _this.statHistory = _this.statHistory.sort(function(a, b){
                return a.time - b.time;
            });
            _this.statHistory.forEach(function(stats){
                addStatPoolHistory(stats);
                addStatWorkerHistory(stats);
                addStatAlgoHistory(stats);
            });
        });
    }

    function addStatPoolHistory(stats){
    //    logger.debug(logSystem, 'Historics', 'addStatPoolHistory');
        var data = {
            time: stats.time,
            pools: {}
        };
        for (var pool in stats.pools){
            data.pools[pool] = {
                hashrate: stats.pools[pool].hashrate,
                workerCount: stats.pools[pool].workerCount,
                blocks: stats.pools[pool].blocks
            }
        }
        _this.statPoolHistory.push(data);
    }

    function addStatWorkerHistory(stats){
    //    logger.debug(logSystem, 'Historics', 'addStatWorkerHistory');
        var data = {
            time: stats.time,
            worker: {}
        };
        for (var pool in stats.pools) {
            for (var worker in stats.pools[pool].workers) {
                //logger.info('addStatWorkerHistory '+ worker);
                if (data.worker[worker] == null) {
                    data.worker[worker] = {
                        algos: {}
                    }

                    data.worker[worker].algos[stats.pools[pool].algorithm] = {
                        hashrate: stats.pools[pool].workers[worker].hashrate
                    }
                } else {
                    var totalHash = data.worker[worker].algos[stats.pools[pool].algorithm].hashrate + stats.pools[pool].workers[worker].hashrate;
                    data.worker[worker].algos[stats.pools[pool].algorithm] = {
                        hashrate: totalHash
                    }
                }
            }
        }
        _this.statWorkerHistory.push(data);
    }

    function addStatAlgoHistory(stats){
        //logger.debug(logSystem, 'Historics', 'addStatAlgoHistory');

        var data = {
            time: stats.time,
            algos: {}
        };
        for (var algo in stats.algos){
            data.algos[algo] = {
                hashrate: stats.algos[algo].hashrate,
                workerCount: stats.algos[algo].workerCount,
            }
        }
        _this.statAlgoHistory.push(data);
    }






/*
    this.getBalanceByAddress = function(address, cback){
        coin ='atradercoin',
        client = redisClients[0].client,
        txns = [];
        balances = [],
        payouts = [];
        count =0;
        balance =0;
        paid = 0;
        logger.debug(logSystem, 'getBalanceByAddress');

        async.parallel([
            function(callback) {
                client.hget(coin + ':balances', address, function(error, value){
                    if (error){
                        callback('There was an error getting balances');
                        return;
                    }
                    if(value === null)
                        balance = 0;
                    else
                        balance = value;

                    //logger.error(logSystem, 'balances', balance);
                    count++;
                    callback();
                });
             },
             function(callback) {
                client.hget(coin + ':payouts', address, function(error, value){
                    if (error){
                        callback('There was an error getting payouts');
                        return;
                    }
                    if(value === null)
                    {
                        timestamp = 0;
                        paid = 0;
                    }
                    else
                    {
                        timestamp = 1;
                        paid = value;

                    }
                        //logger.error(logSystem, 'paid', paid);
                    count++;
                    callback();
                });
            },
            function(callback) {

                client.hgetall(coin + ':Payouts:' + address, function(error, txns){
                    if (error) {
                         callback ('There was no payouts found');
                         return;
                    }
                    if(txns === null){
                         var index = [];
                    } else
                    {
                        payouts = txns;
                    }
                    //logger.error(logSystem, 'txns', txns);

                    count++;
                    callback();
                });
            }

        ], function(err) {
            if (err){
                console.log('ERROR FROM STATS.JS ' + err);
                cback();
            } else {

                //logger.error(logSystem, 'Global exit', count, coin, balance, paid);


                balances.push({
                    coin:coin,
                    balance:balance,
                    paid:paid
                });
                _this.stats.balances = balances;
                _this.stats.payouts= payouts;
                _this.stats.address = address;

                cback();
            }
        });

    }
*/

    this.getBalanceByAddress = function(address, cback){
        var client = redisClients[0].client,
        balances = [],
        payouts = [];

        client.hgetall('Payouts:' + address, function(error, txns){
            if (error) {
                callback ('There was no payouts found');
                return;
            }
            if(txns === null){
                var index = [];
            } else{
                payouts=txns;
            }
        });

        async.each(coinsArray, function(coin, cb){
            client.hget(coin + ':balances', address, function(error, result){
                if (error){
                    callback('There was an error getting balances');
                    return;
                }
                if(result === null)
                {
                    result = -1;
                }
                else
                {
                    result = result;
                }
                client.hget(coin + ':payouts', address, function(error, paid){
                    if (error){
                        callback('There was an error getting payouts');
                        return;
                    }
                    if(paid === null) {
                        paid = 0;
                    }else{
                        paid = paid;
                    }
                    balances.push({
                        coin:coin,
                        balance:result,
                        paid:paid
                    });
                    cb();
                });
            });
        }, function(err){
            if (err){
                console.log('ERROR FROM STATS.JS ' + err);
                cback();
            } else {
                _this.stats.balances = balances;
                _this.stats.address = address;
                cback();
            }
        });
    };


    this.getPayout = function(address, cback){
        logger.debug('getPayout');
        async.waterfall([
            function(callback){
                _this.getBalanceByAddress(address, function(){
                    callback(null, 'test');
                });
            }
        ], function(err, total){
            cback(total);
        });
    };

    this.getPayoutsByCoinAddress = function(coin, address, cback) {
        logger.debug('getPayoutsByCoinAddress');
        var client = redisClients[0].client,
        payouts = [];
        logger.error(logSystem, 'Global', 'Reading payout stats for address ' + coin, address);

        _this.stats.payouts.push({
            coin:coin,
            address:address,
            payout:'12345'
        });

/*

        client.hgetall('Payouts:' + address, function(error, txns){
            if (error) {
                callback ('There was no payouts found');
                return;
            }
            if(txns === null){
                var index = [];
            } else{
                payouts=txns;
            }
        });


*/
         cback();
    };



    this.getGlobalStats = function(callback){
        logger.debug('getGlobalStats');

        var statGatherTime = Date.now() / 1000 | 0;
        var allCoinStats = {};

        async.each(redisClients, function(client, callback){
            var windowTime = (((Date.now() / 1000) - portalConfig.website.stats.hashrateWindow) | 0).toString();
            var redisCommands = [];

            var redisCommandTemplates = [
                ['zremrangebyscore', ':hashrate', '-inf', '(' + windowTime],
                ['zrangebyscore', ':hashrate', windowTime, '+inf'],
                ['hgetall', ':stats'],
                ['scard', ':blocksPending'],
                ['scard', ':blocksConfirmed'],
                ['scard', ':blocksOrphaned']
            ];

            var commandsPerCoin = redisCommandTemplates.length;

            client.coins.map(function(coin){
                redisCommandTemplates.map(function(t){
                    var clonedTemplates = t.slice(0);
                    clonedTemplates[1] = coin + clonedTemplates[1];
                    redisCommands.push(clonedTemplates);
                });
            });

            client.client.multi(redisCommands).exec(function(err, replies){
                if (err){
                    logger.error(logSystem, 'Global', 'error with getting global stats ' + JSON.stringify(err));
                    callback(err);
                }
                else{
                    for(var i = 0; i < replies.length; i += commandsPerCoin){
                        var coinName = client.coins[i / commandsPerCoin | 0];
                        var coinStats = {
                            name: coinName,
                            symbol: poolConfigs[coinName].coin.symbol.toUpperCase(),
                            algorithm: poolConfigs[coinName].coin.algorithm,
                            hashrates: replies[i + 1],
                            poolStats: {
                                validShares: replies[i + 2] ? (replies[i + 2].validShares || 0) : 0,
                                validBlocks: replies[i + 2] ? (replies[i + 2].validBlocks || 0) : 0,
                                invalidShares: replies[i + 2] ? (replies[i + 2].invalidShares || 0) : 0,
                                invalidRate: ((replies[i + 2] ? (replies[i + 2].invalidShares || 0) : 0) / (replies[i + 2] ? (replies[i + 2].validShares || 0) : 0)).toFixed(4),
                                totalPaid: replies[i + 2] ? (replies[i + 2].totalPaid || 0) : 0
                            },
                            blocks: {
                                pending: replies[i + 3],
                                confirmed: replies[i + 4],
                                orphaned: replies[i + 5]
                            }
                        };
                        allCoinStats[coinStats.name] = (coinStats);
                    }
                    callback();
                }
            });
        }, function(err){
            if (err){
                logger.error(logSystem, 'Global', 'error getting all stats' + JSON.stringify(err));
                callback();
                return;
            }

            var portalStats = {
                time: statGatherTime,
                global:{
                    workers: 0,
                    hashrate: 0
                },
                algos: {},
                pools: allCoinStats
            };

            Object.keys(allCoinStats).forEach(function(coin){
                var coinStats = allCoinStats[coin];
                coinStats.workers = {};
                coinStats.shares = 0;
                coinStats.hashrates.forEach(function(ins){
                    var parts = ins.split(':');
                    var workerShares = parseFloat(parts[0]);
                    var worker = parts[1];
                    if (workerShares > 0) {
                        coinStats.shares += workerShares;
                        if (worker in coinStats.workers)
                            coinStats.workers[worker].shares += workerShares;
                        else
                            coinStats.workers[worker] = {
                                shares: workerShares,
                                invalidshares: 0,
				hashrate: 0,
                                hashrateString: null
                            };
                    } else {
                        if (worker in coinStats.workers)
                            coinStats.workers[worker].invalidshares -= workerShares; // workerShares is negative number!
                        else
                            coinStats.workers[worker] = {
                                shares: 0,
                                invalidshares: -workerShares,
				hashrate: 0,
                                hashrateString: null
                            };
                    }
                });

                var shareMultiplier = Math.pow(2, 32) / algos[coinStats.algorithm].multiplier;
                coinStats.hashrate = shareMultiplier * coinStats.shares / portalConfig.website.stats.hashrateWindow;
                coinStats.workerCount = Object.keys(coinStats.workers).length;
                portalStats.global.workers += coinStats.workerCount;

                /* algorithm specific global stats */
                var algo = coinStats.algorithm;
                if (!portalStats.algos.hasOwnProperty(algo)){
                    portalStats.algos[algo] = {
                        workers: 0,
                        hashrate: 0,
                        hashrateString: null
                    };
                }
                portalStats.algos[algo].hashrate += coinStats.hashrate;
                portalStats.algos[algo].workers += Object.keys(coinStats.workers).length;

                for (var worker in coinStats.workers) {
		    coinStats.workers[worker].hashrate = (shareMultiplier * coinStats.workers[worker].shares / portalConfig.website.stats.hashrateWindow);
                    coinStats.workers[worker].hashrateString = _this.getReadableHashRateString(shareMultiplier * coinStats.workers[worker].shares / portalConfig.website.stats.hashrateWindow);
                }

                delete coinStats.hashrates;
                delete coinStats.shares;
                coinStats.hashrateString = _this.getReadableHashRateString(coinStats.hashrate);
            });

            Object.keys(portalStats.algos).forEach(function(algo){
                var algoStats = portalStats.algos[algo];
                algoStats.hashrateString = _this.getReadableHashRateString(algoStats.hashrate);
            });

            _this.stats = portalStats;
            _this.statsString = JSON.stringify(portalStats);

            _this.statHistory.push(portalStats);
            addStatPoolHistory(portalStats);
            addStatAlgoHistory(portalStats);
            addStatWorkerHistory(portalStats);
            var retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0);

            for (var i = 0; i < _this.statHistory.length; i++){
                if (retentionTime < _this.statHistory[i].time){
                    if (i > 0) {
                        _this.statHistory = _this.statHistory.slice(i);
                        _this.statPoolHistory = _this.statPoolHistory.slice(i);
                        _this.statAlgoHistory = _this.statAlgoHistory.slice(i);
                        _this.statWorkerHistory = _this.statWorkerHistory.slice(i);
                    }
                    break;
                }
            }

            redisStats.multi([
                ['zadd', 'statHistory', statGatherTime, _this.statsString],
                ['zremrangebyscore', 'statHistory', '-inf', '(' + retentionTime]
            ]).exec(function(err, replies){
                if (err)
                    logger.error(logSystem, 'Historics', 'Error adding stats to historics ' + JSON.stringify(err));
            });
            callback();
        });
    };

    this.getReadableHashRateString = function(hashrate){
        var i = -1;
        var byteUnits = [ ' KH', ' MH', ' GH', ' TH', ' PH' ];
        do {
            hashrate = hashrate / 1000;
			i++;
        } while (hashrate > 1000);
        return hashrate.toFixed(2) + byteUnits[i];
    };
};
