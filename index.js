// @ts-check
import { createServer } from 'node:http';
import qs from 'node:querystring';
import { setTimeout } from 'node:timers/promises';
import pkg from './package.json' with { type: 'json' };

// Di Windows pakai library asli (kontrol GUI beneran).
// Di OS lain (mis. Ubuntu saat development) otomatis pakai mock supaya
// logikanya bisa dites tanpa aplikasi sidik jari sungguhan.
const bot =
	process.platform === 'win32'
		? (await import('node-autoit-koffi')).default
		: (await import('./mock-bot.js')).default;

const host = `127.0.0.1`; // bind the server to the loopback interface so we don't expose it
const port = Number(process.env.SERVER_PORT) || 3000;
const fp_win_title = process.env.FP_WIN_TITLE || 'Aplikasi Registrasi Sidik Jari';
const fp_ins_path = process.env.FP_INS_PATH || 'C:\\Program Files (x86)\\BPJS Kesehatan\\Aplikasi Sidik Jari BPJS Kesehatan\\After.exe';

// flag standar AutoIt untuk WinSetState; node-autoit-koffi tidak punya
// fungsi "winMinimize" tersendiri, jadi minimize/hide dilakukan lewat winSetState.
const SW_HIDE = 0; // window benar-benar hilang, termasuk dari taskbar (bukan exit, proses tetap jalan)
const SW_MINIMIZE = 6; // window diminimize, masih ada ikonnya di taskbar

// mode "raw" untuk bot.send(): karakter spesial AutoIt (! + ^ { } dst) dikirim
// apa adanya, tidak diinterpretasikan sebagai kombinasi tombol (ALT/SHIFT/CTRL/dst)
const RAW_MODE = 1;

const server = createServer((req, res) => {
	// allow cors
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

	/** @param {Error} error  */
	function handle_error(error) {
		console.error(error);
		json(500, { message: error?.message || `Internal server error` });
	}

	/**
	 * @param {number} status
	 * @param {any =} data
	 */
	function json(status, data) {
		res.writeHead(status, { 'Content-Type': 'application/json' });
		if (!data) return res.end();
		res.end(JSON.stringify(data));
	}

	try {
		const url = new URL(req.url || '/', `http://${host}`);
		if (url.pathname === '/' && req.method === 'GET') {
			// service info
			json(200, { message: pkg.description });
		} else if (url.pathname === '/' && req.method === 'POST') {
			// apm bot service
			let body = '';
			req.on('data', (chunk) => (body += chunk.toString()));
			req.on('end', () => {
				const form_data = qs.parse(body);
				const username = form_data['username'];
				const password = form_data['password'];
				const card_number = form_data['card_number'];
				const exit = form_data['exit'] === 'true';
				const minimize = form_data['minimize'] === 'true';
				const wait = form_data['wait'];

				if (!username || !password || !card_number) {
					return json(400, {
						message: `username, password, and card_number are required fields`
					});
				}

				run_bot({ username, password, card_number, exit, minimize, wait })
					.then(() => json(201))
					.catch((e) => handle_error(e));
			});
		} else if (url.pathname === '/minimize' && req.method === 'POST') {
			// minimize window aplikasi sidik jari, bisa dipanggil kapan saja dari webapp
			minimize_bot()
				.then(() => json(200, { message: `Window minimized` }))
				.catch((e) => handle_error(e));
		} else {
			json(404, { message: `Not found` });
		}
	} catch (error) {
		handle_error(error);
	}
});

server.on('error', (err) => {
	// might to try restarting the server or take other actions
	console.error('Server error:', err);
});

server.listen(port, host, () => {
	console.log(`Server running at http://${host}:${port}`);
});

/** dipanggil lewat POST /minimize, terpisah dari alur login/isi kartu.
 *  Pakai SW_HIDE supaya window benar-benar hilang (tidak muncul di taskbar
 *  juga), tapi proses aplikasinya tetap berjalan (bukan exit/close). */
async function minimize_bot() {
	const already_open = await bot.winExists(fp_win_title);
	if (!already_open) {
		throw new Error(`Aplikasi sidik jari belum terbuka`);
	}
	await bot.winSetState(fp_win_title, '', SW_HIDE);
}

async function run_bot({ username, password, card_number, exit, minimize, wait }) {
	// 1) deteksi apakah aplikasi sudah terbuka sebelumnya
	const already_open = await bot.winExists(fp_win_title);

	if (!already_open) {
		// belum terbuka -> jalankan aplikasinya dulu
		await bot.run(fp_ins_path);
		await bot.winWait(fp_win_title); // tunggu window muncul
	}

	await bot.winActivate(fp_win_title); // pastikan window aktif/fokus
	await bot.winWaitActive(fp_win_title);

	if (exit) {
		await bot.winSetOnTop(fp_win_title, '', 1); // set window on top
	}

	// posisi window dipakai untuk menghitung titik klik yang absolut
	const win_pos = await bot.winGetPos(fp_win_title);
	if (!win_pos) throw new Error('Failed to get window position');
	const { top, left } = win_pos;

	if (already_open) {
		// sudah terbuka -> langsung fokus ke kolom nomor kartu, TIDAK perlu login lagi
		await bot.mouseMove(left + 223, top + 121, 0);
		await bot.mouseClick('left');

		// bersihkan kolom nomor kartu
		await bot.send('^a');
		await bot.send('{BACKSPACE}');
	} else {
		// baru dibuka -> harus login dulu (username & password)
		await bot.mouseMove(left + 223, top + 179, 0);
		await bot.mouseClick('left');

		await setTimeout(1000);

		await bot.send('^a');
		await bot.send('{BACKSPACE}');
		// mode raw (1): karakter spesial seperti ! + ^ { } dikirim apa adanya,
		// tidak dianggap sebagai kombinasi tombol ALT/SHIFT/CTRL/dst
		await bot.send(username.toUpperCase(), RAW_MODE);

		await bot.send('{TAB}');

		await bot.send('^a');
		await bot.send('{BACKSPACE}');
		await bot.send(password.toUpperCase(), RAW_MODE);

		await bot.send('{ENTER}'); // login

		await setTimeout(+wait || 3_593);
	}

	// 2) masukkan nomor kartu (berlaku untuk kedua kondisi di atas)
	await bot.send(card_number, RAW_MODE);

	// 3) tutup atau minimize window sesuai permintaan
	if (exit) {
		await bot.winWaitClose(fp_win_title); // tunggu sampai window ditutup manual
	} else if (minimize) {
		await bot.winSetState(fp_win_title, '', SW_HIDE); // sembunyikan total, tapi proses tetap jalan (bukan exit)
	}
}