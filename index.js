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
const fp_ins_path = process.env.FP_INS_PATH || 'C:\\Program Files (x86)\\Aplikasi Sidik Jari BPJS Kesehatan\\After.exe';

// flag standar AutoIt untuk WinSetState; node-autoit-koffi tidak punya
// fungsi "winMinimize" tersendiri, jadi minimize/hide dilakukan lewat winSetState.
const SW_HIDE = 0; // window benar-benar hilang, termasuk dari taskbar (bukan exit, proses tetap jalan)
const SW_MINIMIZE = 6; // window diminimize, masih ada ikonnya di taskbar
const SW_RESTORE = 9; // kembalikan window ke kondisi normal & terlihat, dari hidden ATAU minimized

// mode "raw" untuk bot.send(): karakter spesial AutoIt (! + ^ { } dst) dikirim
// apa adanya, tidak diinterpretasikan sebagai kombinasi tombol (ALT/SHIFT/CTRL/dst)
const RAW_MODE = 1;

let bot_busy = false;

process.on('uncaughtException', (err) => {
	console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
	console.error('[unhandledRejection]', reason);
});

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
		if (res.headersSent || res.writableEnded) return;
		res.writeHead(status, { 'Content-Type': 'application/json' });
		if (!data) return res.end();
		res.end(JSON.stringify(data));
	}

	// =============================================================
	// PENYEBAB UTAMA "node exit sendiri":
	// Stream request (req) tidak punya listener 'error'. Kalau koneksi
	// terputus di tengah jalan (tab kiosk di-refresh/ditutup, fetch
	// di-abort, timeout jaringan, dsb), req memancarkan event 'error'.
	// Tanpa listener, Node.js menganggapnya uncaught exception dan
	// MEMATIKAN SELURUH PROSES. Listener di bawah ini mencegah itu.
	// =============================================================
	req.on('error', (err) => {
		console.error('Request error:', err);
		json(400, { message: `Request error: ${err.message}` });
	});

	res.on('error', (err) => {
		console.error('Response error:', err);
	});

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
				try {
					const form_data = qs.parse(body);
					const username = form_data['username'];
					const password = form_data['password'];
					const card_number = form_data['card_number'];
					const exit = form_data['exit'] === 'true';
					// default-nya TRUE: window otomatis disembunyikan lagi setelah nomor
					// kartu masuk, kecuali eksplisit dimatikan dengan minimize=false.
					// Ini penting untuk kiosk fullscreen tab biasa (bukan --kiosk), supaya
					// window fingerprint nggak lama-lama nongol di atas fullscreen.
					const minimize = form_data['minimize'] !== 'false';
					const wait = form_data['wait'];

					if (!username || !password || !card_number) {
						return json(400, {
							message: `username, password, and card_number are required fields`
						});
					}

					// >>> CEK LOCK DI SINI <<<
					if (bot_busy) {
						return json(409, {
							message: `Bot sedang memproses request lain, coba lagi sebentar`
						});
					}

					bot_busy = true;
					run_bot({ username, password, card_number, exit, minimize, wait })
						.then(() => json(201))
						.catch((e) => handle_error(e))
						.finally(() => {
							bot_busy = false;
						});
				} catch (error) {
					handle_error(/** @type {Error} */ (error));
				}
			});
		} else if (url.pathname === '/minimize' && req.method === 'POST') {
			// minimize window aplikasi sidik jari, bisa dipanggil kapan saja dari webapp
			if (bot_busy) {
				json(409, { message: `Bot sedang memproses request lain, coba lagi sebentar` });
				return;
			}
			minimize_bot()
				.then(() => json(200, { message: `Window minimized` }))
				.catch((e) => handle_error(e));
		} else {
			json(404, { message: `Not found` });
		}
	} catch (error) {
		handle_error(/** @type {Error} */ (error));
	}
});

server.on('error', (err) => {
	// might to try restarting the server or take other actions
	console.error('Server error:', err);
});

// jaga-jaga kalau ada koneksi TCP yang bermasalah sebelum sempat jadi request
server.on('clientError', (err, socket) => {
	console.error('Client error:', err);
	if (socket.writable) {
		socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
	}
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

	// winActivate TIDAK otomatis membatalkan SW_HIDE/SW_MINIMIZE (ini beda dari
	// visibility window di level Windows), jadi kita paksa restore dulu supaya
	// window yang sempat disembunyikan pasti muncul lagi.
	await bot.winSetState(fp_win_title, '', SW_RESTORE);
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
		await bot.send(username, RAW_MODE);

		await bot.send('{TAB}');

		await bot.send('^a');
		await bot.send('{BACKSPACE}');
		await bot.send(password, RAW_MODE);

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