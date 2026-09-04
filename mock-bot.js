// @ts-check
// Tiruan sederhana dari node-autoit-koffi, khusus untuk development di luar Windows
// (mis. Ubuntu). Semua fungsi hanya mencatat (log) apa yang seharusnya terjadi dan
// mengembalikan nilai dummy, supaya logika di index.js bisa dites lewat curl/fetch
// tanpa aplikasi/GUI sungguhan.
//
// index.js otomatis memakai file ini saat process.platform !== 'win32'.

/** status window disimulasikan di memori supaya perilaku already_open realistis */
let window_open = false;
let window_minimized = false;

function log(action, detail) {
	const state = `(window_open=${window_open}, minimized=${window_minimized})`;
	console.log(`[mock-bot] ${action}`, detail ?? '', state);
}

export default {
	async winExists(title) {
		log('winExists', title);
		return window_open;
	},

	async run(path) {
		log('run', path);
		window_open = true;
		window_minimized = false;
	},

	async winWait(title) {
		log('winWait', title);
	},

	async winActivate(title) {
		log('winActivate', title);
		window_minimized = false;
	},

	async winWaitActive(title) {
		log('winWaitActive', title);
	},

	async winSetOnTop(title, _, flag) {
		log('winSetOnTop', { title, flag });
	},

	async winGetPos(title) {
		log('winGetPos', title);
		// koordinat dummy, boleh disesuaikan kalau perlu simulasikan posisi tertentu
		return { top: 100, left: 100, width: 480, height: 320 };
	},

	async mouseMove(x, y, speed) {
		log('mouseMove', { x, y, speed });
	},

	async mouseClick(button) {
		log('mouseClick', button);
	},

	async send(text) {
		log('send', text);
	},

	async winWaitClose(title) {
		log('winWaitClose', title);
		window_open = false;
	},

	async winMinimize(title) {
		log('winMinimize', title);
		window_minimized = true;
	}
};
