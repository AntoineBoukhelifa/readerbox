#!/usr/bin/env node
/**
 * Sondes de vérification des sources de catalogue (U1).
 *
 * Ce script est jetable. Il ne fait pas partie de l'application : il mesure ce
 * que les API rendent réellement, pour que le document de décision 001 repose
 * sur des constats et non sur des suppositions.
 *
 *   node --env-file=.dev.vars scripts/sondes.js
 *
 * `.dev.vars` est une convention de wrangler que Node ne lit pas tout seul,
 * d'où le drapeau. Surtout, ne pas faire `source .dev.vars` : un `$` dans un
 * mot de passe y serait interprété par le shell et le corromprait en silence.
 *
 * Une source sans identifiants est ignorée plutôt que de faire échouer le
 * reste :
 *
 *   METRON_USER, METRON_PASS   — https://metron.cloud
 *   COMICVINE_KEY              — https://comicvine.gamespot.com/api/
 *   TMDB_KEY                   — https://www.themoviedb.org/settings/api
 *                                (le JETON v4, pas la clé v3)
 *
 * Les cinq questions auxquelles il répond sont celles de U1 :
 *   1. la recherche fonctionne-t-elle
 *   2. le parcours par facette est-il exposé
 *   3. quelle proportion d'œuvres porte une liste de personnages, et combien
 *      de crédits en médiane — ce chiffre borne le volume d'écriture du graphe
 *   4. quelle proportion de recueils expose les numéros qu'ils contiennent
 *   5. que renvoie la source en dépassement de quota
 *
 * Leçon d'une première exécution, gardée ici parce qu'elle vaut pour toute
 * source qu'on ajoutera : la version initiale interrogeait Metron sur `name`,
 * qui cherche dans le *titre de l'histoire* et non dans le nom de la série.
 * Elle tombait sur des numéros obscurs et concluait à 0 % de couverture
 * personnages, alors que la donnée est là. Une mesure fausse est pire qu'une
 * mesure absente : elle a l'air d'une réponse.
 */

/** Comics, par série et numéro — la forme que les bases de comics indexent. */
const COMICS = [
	{ decennie: 1960, serie: 'The Amazing Spider-Man', numero: 1 },
	{ decennie: 1960, serie: 'Fantastic Four', numero: 1 },
	{ decennie: 1960, serie: 'The X-Men', numero: 1 },
	{ decennie: 1980, serie: 'The Uncanny X-Men', numero: 141 },
	{ decennie: 1980, serie: 'Daredevil', numero: 227 },
	{ decennie: 1980, serie: 'Marvel Super Heroes Secret Wars', numero: 1 },
	{ decennie: 2000, serie: 'New Avengers', numero: 1 },
	{ decennie: 2000, serie: 'Civil War', numero: 1 },
	{ decennie: 2000, serie: 'Annihilation', numero: 1 },
	{ decennie: 2020, serie: 'Immortal X-Men', numero: 1 },
	{ decennie: 2020, serie: 'Ultimate Spider-Man', numero: 1 },
	{ decennie: 2020, serie: 'Avengers', numero: 1 }
];

/** Audiovisuel — un échantillon de films, pas de comics. */
const FILMS = [
	{ decennie: 2000, titre: 'Iron Man' },
	{ decennie: 2010, titre: 'The Avengers' },
	{ decennie: 2010, titre: 'Black Panther' },
	{ decennie: 2020, titre: 'Guardians of the Galaxy Vol. 3' }
];

/** Recueils, pour la quatrième question. */
const RECUEILS = ['Civil War', 'House of X', 'Infinity Gauntlet'];

const mediane = (n) => {
	if (!n.length) return 0;
	const t = [...n].sort((a, b) => a - b);
	const m = Math.floor(t.length / 2);
	return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2;
};

const pourcentage = (part, total) => (total === 0 ? '—' : `${Math.round((part / total) * 100)} %`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Un appel, avec attente et reprise sur dépassement de quota.
 *
 * Metron étrangle vers la dizaine d'appels et annonce le délai dans son corps
 * de réponse ; on le respecte plutôt que de conclure à une absence de donnée.
 */
async function appeler(url, entetes = {}, { cadence = 0, essais = 2 } = {}) {
	if (cadence) await pause(cadence);
	const debut = Date.now();
	try {
		const r = await fetch(url, { headers: { 'User-Agent': 'readerbox-sonde', ...entetes } });
		const duree = Date.now() - debut;

		if (r.status === 429 && essais > 0) {
			const corps = await r.text();
			const secondes = Number(/(\d+)\s*second/.exec(corps)?.[1] ?? 15);
			process.stdout.write(`    (quota atteint, attente de ${secondes} s) `);
			await pause((secondes + 2) * 1000);
			return appeler(url, entetes, { cadence: 0, essais: essais - 1 });
		}

		if (!r.ok) return { ok: false, statut: r.status, duree };
		return { ok: true, statut: r.status, duree, corps: await r.json() };
	} catch (e) {
		return { ok: false, statut: 0, duree: Date.now() - debut, erreur: String(e) };
	}
}

const PILOTES = {
	metron: {
		disponible: () => Boolean(process.env.METRON_USER && process.env.METRON_PASS),
		cadence: 2500,
		entetes: () => ({
			Authorization:
				'Basic ' +
				Buffer.from(`${process.env.METRON_USER}:${process.env.METRON_PASS}`).toString('base64')
		}),
		// `series_name` et non `name` : `name` cherche dans le titre de l'histoire.
		chercher: (c) =>
			`https://metron.cloud/api/issue/?series_name=${encodeURIComponent(c.serie)}&number=${c.numero}`,
		premier: (b) => b?.results?.[0],
		detail: (e) => `https://metron.cloud/api/issue/${e.id}/`,
		personnages: (d) => d?.characters ?? null,
		createurs: (d) => d?.credits ?? null,
		serie: (d) => d?.series?.name ?? null,
		arcs: (d) => d?.arcs ?? null,
		// Parcours par personnage : la question 5 de U1.
		parcours: (id) => `https://metron.cloud/api/character/${id}/`,
		idPersonnage: (d) => d?.characters?.[0]?.id ?? null
	},

	comicvine: {
		disponible: () => Boolean(process.env.COMICVINE_KEY),
		cadence: 1200,
		entetes: () => ({}),
		chercher: (c) =>
			`https://comicvine.gamespot.com/api/search/?api_key=${process.env.COMICVINE_KEY}` +
			`&format=json&resources=issue&query=${encodeURIComponent(`${c.serie} ${c.numero}`)}`,
		premier: (b) => b?.results?.[0],
		detail: (e) => `${e.api_detail_url}?api_key=${process.env.COMICVINE_KEY}&format=json`,
		personnages: (d) => d?.results?.character_credits ?? null,
		createurs: (d) => d?.results?.person_credits ?? null,
		serie: (d) => d?.results?.volume?.name ?? null,
		arcs: (d) => d?.results?.story_arc_credits ?? null,
		parcours: null,
		idPersonnage: () => null
	}
};

async function sonderComics(nom, pilote) {
	console.log(`\n${'='.repeat(62)}\n${nom} — comics\n${'='.repeat(62)}`);
	if (!pilote.disponible()) return console.log('Identifiants absents — source ignorée.\n');

	const entetes = pilote.entetes();
	const credits = [];
	let trouvees = 0;
	let avecPersonnages = 0;
	let echecs = 0;
	let dureeMax = 0;
	let idPersonnage = null;
	const parDecennie = {};

	for (const cas of COMICS) {
		const etiquette = `${cas.serie} #${cas.numero}`;
		parDecennie[cas.decennie] ??= { total: 0, avec: 0 };
		parDecennie[cas.decennie].total++;

		const recherche = await appeler(pilote.chercher(cas), entetes, { cadence: pilote.cadence });
		dureeMax = Math.max(dureeMax, recherche.duree);
		if (!recherche.ok) {
			echecs++;
			console.log(`  ✗ ${etiquette} — statut ${recherche.statut}`);
			continue;
		}

		const element = pilote.premier(recherche.corps);
		if (!element) {
			console.log(`  · ${etiquette} — aucun résultat`);
			continue;
		}
		trouvees++;

		const detail = await appeler(pilote.detail(element), entetes, { cadence: pilote.cadence });
		dureeMax = Math.max(dureeMax, detail.duree);
		if (!detail.ok) {
			echecs++;
			console.log(`  ✗ ${etiquette} — détail en statut ${detail.statut}`);
			continue;
		}

		const personnages = pilote.personnages(detail.corps);
		const createurs = pilote.createurs(detail.corps) ?? [];
		const arcs = pilote.arcs(detail.corps) ?? [];

		if (Array.isArray(personnages) && personnages.length) {
			avecPersonnages++;
			parDecennie[cas.decennie].avec++;
			credits.push(personnages.length);
			idPersonnage ??= pilote.idPersonnage?.(detail.corps) ?? null;
			console.log(
				`  ✓ ${etiquette} — ${personnages.length} personnages, ${createurs.length} crédits, ${arcs.length} arcs`
			);
		} else {
			console.log(`  ○ ${etiquette} — aucun personnage crédité`);
		}
	}

	console.log(`\n  Recherches abouties         : ${trouvees}/${COMICS.length}`);
	console.log(`  Échecs réseau ou API        : ${echecs}`);
	console.log(
		`  Avec personnages            : ${avecPersonnages}/${trouvees} (${pourcentage(avecPersonnages, trouvees)})`
	);
	console.log(`  Crédits par numéro, médiane : ${mediane(credits)}`);
	console.log(`  Latence maximale observée   : ${dureeMax} ms`);

	console.log('\n  Couverture personnages par décennie :');
	for (const [d, c] of Object.entries(parDecennie).sort()) {
		console.log(`    ${d} : ${c.avec}/${c.total} (${pourcentage(c.avec, c.total)})`);
	}

	const recent = [parDecennie[2000], parDecennie[2020]].filter(Boolean);
	const t = recent.reduce((n, d) => n + d.total, 0);
	const a = recent.reduce((n, d) => n + d.avec, 0);
	if (t) {
		console.log(
			`\n  Seuil U1 (70 % sur le post-2000) : ${pourcentage(a, t)} → ` +
				(a / t >= 0.7 ? 'la dimension personnage tient' : 'graphe à réduire à série + event')
		);
	}

	if (pilote.parcours && idPersonnage) {
		const p = await appeler(pilote.parcours(idPersonnage), entetes, { cadence: pilote.cadence });
		console.log(
			`\n  Parcours par personnage : ${p.ok ? 'exposé' : `indisponible (statut ${p.statut})`}`
		);
	} else if (!pilote.parcours) {
		console.log('\n  Parcours par personnage : non sondé pour cette source');
	}
}

async function sonderRecueils(nom, pilote) {
	if (!pilote.disponible() || nom !== 'metron') return;
	console.log(`\n  Composition des recueils :`);
	const entetes = pilote.entetes();
	for (const titre of RECUEILS) {
		const r = await appeler(
			`https://metron.cloud/api/series/?name=${encodeURIComponent(titre)}`,
			entetes,
			{ cadence: pilote.cadence }
		);
		if (!r.ok) {
			console.log(`    ✗ ${titre} — statut ${r.statut}`);
			continue;
		}
		const n = r.corps?.count ?? 0;
		console.log(`    ${n ? '✓' : '·'} ${titre} — ${n} série(s) trouvée(s)`);
	}
	console.log(
		'    (Metron modélise les recueils comme des séries de type « trade paperback » ;\n' +
			'     la liste des numéros contenus reste à confirmer sur une fiche précise.)'
	);
}

async function sonderTmdb() {
	console.log(`\n${'='.repeat(62)}\ntmdb — films et séries\n${'='.repeat(62)}`);
	if (!process.env.TMDB_KEY) return console.log('Jeton absent — source ignorée.\n');

	const entetes = { Authorization: `Bearer ${process.env.TMDB_KEY}` };
	let trouvees = 0;
	const castings = [];
	let dureeMax = 0;

	for (const film of FILMS) {
		const r = await appeler(
			`https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(film.titre)}`,
			entetes
		);
		dureeMax = Math.max(dureeMax, r.duree);
		if (!r.ok) {
			console.log(`  ✗ ${film.titre} — statut ${r.statut}`);
			continue;
		}
		const premier = r.corps?.results?.[0];
		if (!premier) {
			console.log(`  · ${film.titre} — aucun résultat`);
			continue;
		}
		trouvees++;

		const d = await appeler(
			`https://api.themoviedb.org/3/movie/${premier.id}?append_to_response=credits`,
			entetes
		);
		dureeMax = Math.max(dureeMax, d.duree);
		const cast = d.corps?.credits?.cast ?? [];
		castings.push(cast.length);
		console.log(
			`  ✓ ${film.titre} — ${cast.length} au casting, affiche ${premier.poster_path ? 'oui' : 'non'}`
		);
	}

	console.log(`\n  Films trouvés              : ${trouvees}/${FILMS.length}`);
	console.log(`  Casting par film, médiane  : ${mediane(castings)}`);
	console.log(`  Latence maximale observée  : ${dureeMax} ms`);
	console.log(
		'\n  Note : le casting TMDB liste des acteurs, pas des personnages de fiction\n' +
			'  au sens du graphe. Il ne nourrit pas la dimension personnage de R49.'
	);
}

for (const [nom, pilote] of Object.entries(PILOTES)) {
	await sonderComics(nom, pilote);
	await sonderRecueils(nom, pilote);
}
await sonderTmdb();

console.log('\nReporter ces chiffres dans docs/decisions/001-sources-de-donnees.md.\n');
