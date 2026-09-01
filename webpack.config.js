const path = require('path');

module.exports = {
    entry: {
        controller: path.join(__dirname, 'src/controller.tsx'),
        background: path.join(__dirname, 'src/background.ts'),
    },
    output: {
        path: path.join(__dirname, 'dist/js'),
        filename: '[name].js',
        clean: true,
    },
    devtool: 'source-map',
    module: {
        rules: [{
            exclude: /node_modules/,
            test: /\.tsx?$/,
            loader: 'ts-loader'
        }]
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js', '.json'],
    }
};
