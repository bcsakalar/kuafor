/**
 * PM2 config for running this app on a host machine.
 * - DB stays in Docker (see docker-compose.yml)
 * - App runs on PORT=5001 behind Nginx
 */

module.exports = {
	apps: [
		{
			name: 'berber',
			script: 'src/server.js',
			cwd: __dirname,
			node_args: [],
			instances: 1,
			exec_mode: 'fork',
			autorestart: true,
			max_restarts: 10,
			env: {
				NODE_ENV: 'production',
				PORT: '5001',
			},
		},
	],
};
