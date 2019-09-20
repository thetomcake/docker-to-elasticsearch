const DEBUG = parseInt(process.env.DEBUG) || 0 ? true : false;
const ES_HOST = process.env.ES_HOST || 'localhost'; // The hostname for the Elasticsearch server (pooling not supported currently)
const ES_PORT = process.env.ES_PORT || 9200;  // The port for the Elasticsearch server
const ES_USERNAME = process.env.ES_USERNAME || null;  // The username for the Elasticsearch server
const ES_PASSWORD = process.env.ES_PASSWORD || null;  // The password for the Elasticsearch server
const ES_PROTO = process.env.ES_PROTO || 'https'; // The protocol used for the Elasticsearch server connections
const ES_INDEX = process.env.ES_INDEX || 'logs'; // The Elasticsearch index the data should be stored in
const ES_INDEX_DATE_APPENDIX = parseInt(process.env.ES_INDEX_DATE_APPENDIX) ? true : false;
const ES_TYPE = process.env.ES_TYPE || 'row'; // The type of the data to be stored in Elasticsearch
const QUEUE_LIMIT = process.env.QUEUE_LIMIT || 200; // The maximum number of items that should be queued before pushing to Elasticsearch
const QUEUE_TIMEOUT = process.env.QUEUE_TIMEOUT || 120; // The maximum seconds for an item to be in the queue before it is pushed to Elasticsearch

// ---------

const Es =  require('elasticsearch');
const Docker = require('dockerode');
const { dd } = require('dumper.js');
const Loghose = require('docker-loghose');
const through = require('through2');
const Alpine = new require('alpine');
const esClient = new Es.Client( {
    hosts: [
        ES_PROTO + '://' + (!!ES_USERNAME && !!ES_PASSWORD ? ES_USERNAME + ':' + ES_PASSWORD + '@' : '') + ES_HOST + ':' + ES_PORT,
    ]
});
const utf8 = require('utf8');
const docker = new Docker({socketPath: '/var/run/docker.sock'});
const alpine = new Alpine(Alpine.LOGFORMATS.COMBINED);

let queue = [];
let queueTimeout = null;
let existingEsIndicies = [];

let debug = function(...args) {
    if (DEBUG) {
        console.debug(...args);
    }
};

let fatal = function(...args) {
    console.error(...args);
    process.exit();
};

let error = function(...args) {
    console.error(...args);
};

let handleOutput = function(stream, containerData, data) {
    if (data.indexOf("\n") !== -1) {
        data.split("\n").forEach((dataRow) => {
            handleOutput(stream, containerData, dataRow);
        });
        return;
    }

    let output = {
        'labels': [],
        'message': data,
        'timestamp': (new Date).getTime()
    };

    if (data.match(/^(\S+) (\S+) (\S+) \[([\w:/]+\s[+\-]\d{4})\] "(\S+)\s?(\S+)?\s?(\S+)?" (\d{3}|-) (\d+|-)\s?"?([^"]*)"?\s?"?([^"]*)?"?$/)) {
        try {
            output.apache = alpine.parseLine(data);
            delete output.apache.originalLine;
            output.type = 'apache-combined';
            output.labels.push('_alpine.parsed');
        } catch (err) {
            output.labels.push('_alpine.parseerror');
        }
    }

    output.stream = stream;
    output.docker = {
        'name': containerData.Names.join(),
        'image': containerData.Image,
        'command': containerData.Command,
        'created': containerData.Created
    };

    pushToQueue(output);
};

let pushToQueue = function(data) {
    createEsIndexIfNotExists(getEsIndex()).then(() => {
        queue.push({
            index: {
                _index: getEsIndex(),
                _type: ES_TYPE
            }
        });
        queue.push(data);
        afterPushToQueue();
    });
};

let afterPushToQueue = function() {
    if (queue.length / 2 >= QUEUE_LIMIT) {
        flushQueue();
    };

    if (queueTimeout === null) {
        queueTimeout = setTimeout(() => {
            flushQueue();
        }, QUEUE_TIMEOUT * 1000);
    }
};

let flushQueue = function() {
    return new Promise((accept, reject) => {
        if (queueTimeout) {
            clearTimeout(queueTimeout);
        }

        if (!queue.length) {
            debug('Skipping flushIndexQueue, no items to process');
            return accept();
        }

        let flushingQueue = queue.slice(0);
        queue = [];
        let indexQueueLength = flushingQueue.length / 2;
        debug('Flushing queue of ' + indexQueueLength + ' items');
        esClient.bulk({
            body: flushingQueue
        }, (err, resp, status) => {
            if (err) {
                error('Unable to flush queue', err, resp);
                debug('Readding ' + indexQueueLength + ' items to the queue');
                queue = flushingQueue.concat(queue);
                debug('New queue length: ' + (queue.length / 2));
                reject();
            } else {
                debug('Successfully created ' + indexQueueLength + ' indices', resp);
            }
        });
    });

};

let getEsIndex = function() {
    return ES_INDEX + (ES_INDEX_DATE_APPENDIX ? (new Date).toISOString().substr(0, 10) : '')
};

let createEsIndexIfNotExists = function(index) {
    return new Promise((accept, reject) => {

        if (existingEsIndicies.indexOf(index) !== -1) {
            return accept(); //already exists
        }

        esClient.indices.get({index}).then((a) => {
            debug('ES Index found', index);
            existingEsIndicies.push(index);
            return accept();
        }).catch((err) => {
            if (err.status === 404) {
                let mappings = {"timestamp": {"properties": {"timestamp": {"type": "date"}}}};
                esClient.indices.create({
                    index,
                    "body": {mappings}
                }, (err, resp, status) => {
                    if (err) {
                        error('Unable to create index', err);
                        return reject();
                    } else {
                        existingEsIndicies.push(index);
                        debug('Index ' + index + ' created successfully');
                        return accept();
                    }
                });
            } else {
                error('Unable to get existing indicies list', err);
            }
        });

    });
};

let handleFinish = function(containerData) {
    debug('Handling finish for ' + containerData.Names.join());
    if (attachedContainers[containerData.Id]) {
        delete attachedContainers[containerData.Id];
    }
};

let handleAttach = function(containerData) {
    debug('Attached to ' + containerData.Names.join());
    attachedContainers[containerData.Id] = containerData;
};

let handleStream = function(container, containerData, stream) {
    let stdOutStream = through(function (chunk, enc, cb) {
        handleOutput('stdout', containerData, chunk.toString('utf8').trim());
        cb();
    });
    let stdErrStream = through(function (chunk, enc, cb) {
        handleOutput('stderr', containerData, chunk.toString('utf8').trim());
        cb();
    });

    container.modem.demuxStream(stream, stdOutStream, stdErrStream);
};

let attachToContainer = function(containerData) {
    let container = docker.getContainer(containerData.Id);
    debug('Attempting to attach to ' + containerData.Names.join());
    container.attach({stdout: true, stderr: true, stream: true}).then((stream) => {
        handleStream(container, containerData, stream);
        handleAttach(containerData);
        stream.on('finish', () => handleFinish(containerData));
        stream.on('close', () => handleFinish(containerData));
    }).catch(() => {
        console.error('Failed to attach to container ' + containerData.Id);
        handleFinish((containerData));
    });
};

let processLogsSinceStarted = function(containerData) {
    let container = docker.getContainer(containerData.Id);
    debug('Processing logs since start for ' + containerData.Names.join());
    container.logs({stdout: true, stderr: true, follow: false}).then((data) => {
        let rows = data.split("\n").slice(0, -1);
        rows.forEach((row) => {
            let buffer = Buffer.from(row, 'utf-8');
            let streamNumber = buffer.readInt8();
            let stream = (streamNumber === 1 ? 'stdout' : (streamNumber === 2 ? 'stderr' : 'unknown'));
            handleOutput(stream, containerData, buffer.toString('utf-8', 8));
        });
    }).catch((err) => {
        console.log(err);
         console.error('Unable to process logs since started for container: ' + containerData.Id);
    });
};

let refreshContainers = function() {
    debug('Refreshing containers');
    let existingContainerIds = [];
    docker.listContainers().then((containers) => {
        containers.forEach((containerData) => {
            existingContainerIds.push(containerData.Id);
            if (!attachedContainers[containerData.Id]) {
                attachToContainer(containerData);
                if (containerData.Created > lastRefresh ) { // && lastRefresh !== null
                    debug('Container created ' + containerData.Created + ', last refreshed at ' + lastRefresh);
                    processLogsSinceStarted(containerData);
                }
            }
        });

        lastRefresh = parseInt((new Date).getTime() / 1000);
    });

    Object.keys(attachedContainers).forEach((containerId) => {
        if (existingContainerIds.indexOf(containerId) === -1) {
            handleFinish(attachedContainers[containerId]);
        };
    });

    if (existingContainerIds.length) {
        debug('Refreshed containers: ', existingContainerIds);
    }
};

let lastRefresh = null;
let attachedContainers = {};

console.log('Started');
debug('Debug enabled');

refreshContainers();
setInterval(() => {
    refreshContainers();
}, 10000);
