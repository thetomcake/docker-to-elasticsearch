const config = require("./config");

module.exports = {
    debug: function(...args) {
        if (config.DEBUG) {
            console.debug(...args);
        }
    },
    fatal: function(...args) {
        console.error(...args);
        process.exit();
    },
    error: function(...args) {
        console.error(...args);
    }
};


