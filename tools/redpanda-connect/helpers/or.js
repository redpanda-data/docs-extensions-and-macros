module.exports = function (...args) {
    const options = args.pop(); // Last argument is always the options object
    return args.some(Boolean);
};
