module.exports = {
    DEBUG: parseInt(process.env.DEBUG) || 0 ? true : false,
    ES_HOST: process.env.ES_HOST || 'localhost', // The hostname for the Elasticsearch server (pooling not supported currently)
    ES_PORT: process.env.ES_PORT || 9200,  // The port for the Elasticsearch server
    ES_USERNAME: process.env.ES_USERNAME || null,  // The username for the Elasticsearch server
    ES_PASSWORD: process.env.ES_PASSWORD || null,  // The password for the Elasticsearch server
    ES_PROTO: process.env.ES_PROTO || 'https', // The protocol used for the Elasticsearch server connections
    ES_INDEX: process.env.ES_INDEX || 'logs', // The Elasticsearch index the data should be stored in
    ES_INDEX_DATE_APPENDIX: parseInt(process.env.ES_INDEX_DATE_APPENDIX) ? true : false,
    ES_TYPE: process.env.ES_TYPE || '_doc', // The type of the data to be stored in Elasticsearch
    ES_VERSION: process.env.ES_VERSION || '6.8', // The version of the Elasticsearch server
    ES_MAPPING: process.env.ES_MAPPING ? JSON.parse(process.env.ES_MAPPING) : {"properties": {"timestamp": {"type": "date"}}},
    QUEUE_LIMIT: process.env.QUEUE_LIMIT || 200, // The maximum number of items that should be queued before pushing to Elasticsearch
    QUEUE_TIMEOUT: process.env.QUEUE_TIMEOUT || 120, // The maximum seconds for an item to be in the queue before it is pushed to Elasticsearch
    DOCKER_IMAGE_PATTERN: process.env.DOCKER_IMAGE_PATTERN || null
};

    
