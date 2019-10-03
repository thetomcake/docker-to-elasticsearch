const esClient = require('./esClient');
const log = require("./log");
const through = require('through2');
const Alpine = new require('alpine');
const alpine = new Alpine(Alpine.LOGFORMATS.COMBINED);
const utf8 = require('utf8');
const config = require('./config');
const Docker = require('dockerode');
const docker = new Docker({socketPath: '/var/run/docker.sock'});

let lastRefresh = null;
let attachedContainers = {};

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

    esClient.queue(output);
};

let handleFinish = function(containerData) {
    log.debug('Handling finish for ' + containerData.Names.join());
    if (attachedContainers[containerData.Id]) {
        delete attachedContainers[containerData.Id];
    }
};

let handleAttach = function(containerData) {
    log.debug('Attached to ' + containerData.Names.join());
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
    log.debug('Attempting to attach to ' + containerData.Names.join());
    container.attach({stdout: true, stderr: true, stream: true}).then((stream) => {
        handleStream(container, containerData, stream);
        handleAttach(containerData);
        stream.on('finish', () => handleFinish(containerData));
        stream.on('close', () => handleFinish(containerData));
    }).catch(() => {
        log.error('Failed to attach to container ' + containerData.Id);
        handleFinish((containerData));
    });
};

let processLogsSinceStarted = function(containerData) {
    let container = docker.getContainer(containerData.Id);
    log.debug('Processing logs since start for ' + containerData.Names.join());
    container.logs({stdout: true, stderr: true, follow: false}).then((data) => {
        let rows = data.split("\n").slice(0, -1);
        rows.forEach((row) => {
            let buffer = Buffer.from(row, 'utf-8');
            let streamNumber = buffer.readInt8();
            let stream = (streamNumber === 1 ? 'stdout' : (streamNumber === 2 ? 'stderr' : 'unknown'));
            handleOutput(stream, containerData, buffer.toString('utf-8', 8));
        });
    }).catch((err) => {
        log.error('Unable to process logs since started for container: ' + containerData.Id, err);
    });
};

let refreshContainers = function() {
    log.debug('Refreshing containers');
    let existingContainerIds = [];
    docker.listContainers().then((containers) => {
        containers.forEach((containerData) => {
            if (config.DOCKER_IMAGE_PATTERN === null || containerData.Image.substr(0, config.DOCKER_IMAGE_PATTERN.length) === config.DOCKER_IMAGE_PATTERN) {
                existingContainerIds.push(containerData.Id);
                if (!attachedContainers[containerData.Id]) {
                    attachToContainer(containerData);
                    if (containerData.Created > lastRefresh ) { // && lastRefresh !== null
                        log.debug('Container created ' + containerData.Created + ', last refreshed at ' + lastRefresh);
                        processLogsSinceStarted(containerData);
                    }
                }
            }
        });

        Object.keys(attachedContainers).forEach((containerId) => {
            if (existingContainerIds.indexOf(containerId) === -1) {
                handleFinish(attachedContainers[containerId]);
            }
        });

        if (existingContainerIds.length) {
            log.debug('Refreshed containers: ', existingContainerIds);
        }

        lastRefresh = parseInt((new Date).getTime() / 1000);
    });
};

let connected = false;
module.exports = {
    startLogging: function() {
        if (!connected) {
            connected = true;
            refreshContainers();
            setInterval(() => {
                refreshContainers();
            }, 30000);
        }
    }
};

