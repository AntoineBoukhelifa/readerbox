#!/usr/bin/env node
/**
 * Sondes de vérification des sources de catalogue (U1).
 *
 * Ce script est jetable. Il ne fait pas partie de l'application : il mesure ce
 * que les API rendent réellement, pour que le document de décision 001 repose
 * sur des constats et non sur des suppositions.
 *
 *   node scripts/sondes.js
 *
 * Les clés se lisent dans l'environnement. Une source sans clé est ignorée
 * plutôt que de faire échouer le reste :
 *
 *   METRON_USER, METRON_PASS   — https://metron.cloud (compte gratuit)
 *   COMICVINE_KEY              — https://comicvine.gamespot.com/api/
 *   TMDB_KEY                   — https://www.themoviedb.org/settings/api
 *
 * Les cinq questions auxquelles il répond sont celles de U1 :
 *   1. la recherche par titre fonctionne-t-elle
 *   2. le parcours par facette est-il exposé
 *   3. quelle proportion de numéros porte une liste de personnages, et combien
 *      de crédits en médiane — ce chiffre borne le volume d'écriture du graphe
 *   4. quelle proportion de recueils expose les numéros qu'ils contiennent
 *   5. que renvoie la source en dépassement de quota
 */

const ECHANTILLON = [
	// Un échantillon volontairement étalé : la donnée de personnages est réputée
	// bonne sur le récent et lacunaire sur l'ancien, et c'est exactement l'écart
	// qu'on cherche à chiffrer.
	{ decennie: 1960, requete: 'Amazing Spider-Man 1963' },
	{ decennie: 1960, requete: 'Fantastic Four 1961' },
	{ decennie: 1960, requete: 'X-Men 1963' },
	{ decennie: 1980, requete: 'Uncanny X-Men 141' },
	{ decennie: 1980, requete: 'Daredevil Born Again' },
	{ decennie: 1980, requete: 'Secret Wars 1984' },
	{ decennie: 2000, requete: 'New Avengers 2005' },
	{ decennie: 2000, requete: 'Civil War 2006' },
	{ decennie: 2000, requete: 'Annihilation 2006' },
	{ decennie: 2020, requete: 'Immortal X-Men' },
	{ decennie: 2020, requete: 'Ultimate Spider-Man 2024' },
	{ decennie: 2020, requete: 'Avengers 2023' }
];

const mediane = (nombres) => {
	if (nombres.length === 0) return 0;
	const tries = [...nombres].sort((a, b) => a - b);
	const milieu = Math.floor(tries.length / 2);
	return tries.length % 2 ? tries[milieu] : (tries[milieu - 1] + tries[milieu]) / 2;
};

const pourcentage = (part, total) => (total === 0 ? '—' : `${Math.round((part / total) * 100)} %`);

async function appeler(url, entetes = {}) {
	const debut = Date.now();
	try {
		const reponse = await fetch(url, { headers: { 'User-Agent': 'readerbox-sonde', ...entetes } });
		const duree = Date.now() - debut;
		const quota = {
			restant: reponse.headers.get('x-ratelimit-remaining'),
			reinit: reponse.headers.get('x-ratelimit-reset'),
			retenter: reponse.headers.get('retry-after')
		};
		if (!reponse.ok) return { ok: false, statut: reponse.status, duree, quota };
		return { ok: true, statut: reponse.status, duree, quota, corps: await reponse.json() };
	} catch (erreur) {
		return { ok: false, statut: 0, duree: Date.now() - debut, erreur: String(erreur) };
	}
}

/**
 * Les pilotes décrivent, par source, comment poser chaque question.
 *
 * Les points d'entrée ci-dessous sont ceux que la documentation publique
 * annonce, mais ils n'ont pas été vérifiés en conditions réelles — c'est
 * précisément le travail de U1b. Une réponse inattendue doit faire corriger le
 * pilote, pas être contournée en silence.
 */
const PILOTES = {
	metron: {
		disponible: () => Boolean(process.env.METRON_USER && process.env.METRON_PASS),
		entetes: () => ({
			Authorization:
				'Basic ' +
				Buffer.from(`${process.env.METRON_USER}:${process.env.METRON_PASS}`).toString('base64')
		}),
		rechercher: (q) => `https://metron.cloud/api/issue/?name=${encodeURIComponent(q)}`,
		premier: (corps) => corps?.results?.[0],
		detail: (element) => `https://metron.cloud/api/issue/${element.id}/`,
		personnages: (detail) => detail?.characters ?? null,
		contenu: () => null
	},

	comicvine: {
		disponible: () => Boolean(process.env.COMICVINE_KEY),
		entetes: () => ({}),
		rechercher: (q) =>
			`https://comicvine.gamespot.com/api/search/?api_key=${process.env.COMICVINE_KEY}` +
			`&format=json&resources=issue&query=${encodeURIComponent(q)}`,
		premier: (corps) => corps?.results?.[0],
		detail: (element) =>
			`${element.api_detail_url}?api_key=${process.env.COMICVINE_KEY}&format=json`,
		personnages: (detail) => detail?.results?.character_credits ?? null,
		contenu: (detail) => detail?.results?.issues ?? null
	},

	tmdb: {
		disponible: () => Boolean(process.env.TMDB_KEY),
		entetes: () => ({ Authorization: `Bearer ${process.env.TMDB_KEY}` }),
		rechercher: (q) => `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(q)}`,
		premier: (corps) => corps?.results?.[0],
		detail: (element) =>
			`https://api.themoviedb.org/3/movie/${element.id}?append_to_response=credits`,
		personnages: (detail) => detail?.credits?.cast ?? null,
		contenu: () => null
	}
};

async function sonder(nom, pilote) {
	console.log(`\n${'='.repeat(60)}\n${nom}\n${'='.repeat(60)}`);

	if (!pilote.disponible()) {
		console.log('Clé absente — source ignorée.');
		return;
	}

	const entetes = pilote.entetes();
	const crédits = [];
	let trouvees = 0;
	let avecPersonnages = 0;
	let indisponibles = 0;
	const parDecennie = {};
	let dureeMax = 0;
	let dernierQuota = null;

	for (const cas of ECHANTILLON) {
		parDecennie[cas.decennie] ??= { total: 0, avecPersonnages: 0 };
		parDecennie[cas.decennie].total++;

		const recherche = await appeler(pilote.rechercher(cas.requete), entetes);
		dureeMax = Math.max(dureeMax, recherche.duree);
		if (recherche.quota?.restant) dernierQuota = recherche.quota;

		if (!recherche.ok) {
			indisponibles++;
			console.log(`  ✗ ${cas.requete} — statut ${recherche.statut}`);
			continue;
		}

		const element = pilote.premier(recherche.corps);
		if (!element) {
			console.log(`  · ${cas.requete} — aucun résultat`);
			continue;
		}
		trouvees++;

		const detail = await appeler(pilote.detail(element), entetes);
		dureeMax = Math.max(dureeMax, detail.duree);
		if (!detail.ok) {
			indisponibles++;
			console.log(`  ✗ ${cas.requete} — détail en statut ${detail.statut}`);
			continue;
		}

		const personnages = pilote.personnages(detail.corps);
		if (Array.isArray(personnages) && personnages.length > 0) {
			avecPersonnages++;
			parDecennie[cas.decennie].avecPersonnages++;
			crédits.push(personnages.length);
			console.log(`  ✓ ${cas.requete} — ${personnages.length} personnages`);
		} else {
			console.log(`  ○ ${cas.requete} — aucun personnage crédité`);
		}
	}

	console.log(`\n  Recherches abouties        : ${trouvees}/${ECHANTILLON.length}`);
	console.log(`  Échecs réseau ou API       : ${indisponibles}`);
	console.log(
		`  Avec personnages           : ${avecPersonnages}/${trouvees} (${pourcentage(avecPersonnages, trouvees)})`
	);
	console.log(`  Crédits par numéro, médiane: ${mediane(crédits)}`);
	console.log(`  Latence maximale observée  : ${dureeMax} ms`);
	if (dernierQuota) console.log(`  Quota (en-têtes)           : ${JSON.stringify(dernierQuota)}`);

	console.log('\n  Couverture personnages par décennie :');
	for (const [decennie, chiffres] of Object.entries(parDecennie).sort()) {
		console.log(
			`    ${decennie} : ${chiffres.avecPersonnages}/${chiffres.total} ` +
				`(${pourcentage(chiffres.avecPersonnages, chiffres.total)})`
		);
	}

	// Le seuil de décision de U1, fixé avant la mesure : sous 70 % de couverture
	// sur le post-2000, la dimension personnage du graphe est abandonnée.
	const recent = [parDecennie[2000], parDecennie[2020]].filter(Boolean);
	const totalRecent = recent.reduce((n, d) => n + d.total, 0);
	const avecRecent = recent.reduce((n, d) => n + d.avecPersonnages, 0);
	if (totalRecent > 0) {
		const taux = avecRecent / totalRecent;
		console.log(
			`\n  Seuil U1 (70 % sur le post-2000) : ${pourcentage(avecRecent, totalRecent)} → ` +
				(taux >= 0.7 ? 'la dimension personnage tient' : 'graphe à réduire à série + event')
		);
	}
}

for (const [nom, pilote] of Object.entries(PILOTES)) {
	await sonder(nom, pilote);
}

console.log('\nReporter ces chiffres dans docs/decisions/001-sources-de-donnees.md.\n');
