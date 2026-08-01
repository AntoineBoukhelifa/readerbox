import { describe, expect, it } from 'vitest';
import { creerTmdb, decouper, referenceTmdb } from './tmdb';
import { transportFactice } from './testing';
import rechercheReelle from './fixtures/tmdb-search-multi.json';
import filmReel from './fixtures/tmdb-movie-detail.json';
import serieReelle from './fixtures/tmdb-tv-detail.json';
import collectionReelle from './fixtures/tmdb-collection.json';

/** Mêmes fixtures réelles que pour Metron, capturées le 2026-08-01. */

function tmdb(reponses: Parameters<typeof transportFactice>[0]) {
	const factice = transportFactice(reponses);
	return { adaptateur: creerTmdb({ jeton: 'jeton', transport: factice.transport }), ...factice };
}

describe('identifiants', () => {
	it('préfixe par espace : le film 1726 et la série 1726 ne sont pas la même chose', () => {
		expect(referenceTmdb('film', 1726)).toEqual({ source: 'tmdb', idExterne: 'film:1726' });
		expect(decouper('serie:3097')).toEqual({ espace: 'serie', id: '3097' });
		expect(decouper('3097')).toBeNull();
	});
});

describe('recherche', () => {
	it('rend films et séries, et écarte les personnes que search/multi y mêle', async () => {
		const { adaptateur } = tmdb([{ quand: 'search/multi', corps: rechercheReelle }]);

		const trouvees = await adaptateur.rechercher('Iron Man');
		if (!trouvees.ok) throw new Error(trouvees.motif);

		expect(trouvees.valeur.elements.map((oeuvre) => oeuvre.reference.idExterne)).toEqual([
			'film:1726',
			'serie:3097'
		]);
	});

	it('mappe le titre, la date et l’affiche selon le type', async () => {
		const { adaptateur } = tmdb([{ quand: 'search/multi', corps: rechercheReelle }]);

		const trouvees = await adaptateur.rechercher('Iron Man');
		if (!trouvees.ok) throw new Error(trouvees.motif);

		expect(trouvees.valeur.elements[0]).toMatchObject({
			type: 'film',
			titre: 'Iron Man',
			dateDeParution: '2008-04-30',
			couvertureUrl: 'https://image.tmdb.org/t/p/w342/78lPtwv72eTNqFW9COBYI0dWDJa.jpg'
		});
		expect(trouvees.valeur.elements[1]).toMatchObject({
			type: 'serie',
			titre: 'Iron Man',
			dateDeParution: '1994-09-24'
		});
	});

	it('les personnages sont « absents » et non « indisponibles » : TMDB n’en crédite aucun', async () => {
		const { adaptateur } = tmdb([{ quand: 'search/multi', corps: rechercheReelle }]);

		const trouvees = await adaptateur.rechercher('Iron Man');
		if (!trouvees.ok) throw new Error(trouvees.motif);

		// « Indisponibles » ferait de chaque film une ingestion éternellement
		// partielle, que le rattrapage rejouerait pour ne jamais rien trouver.
		expect(trouvees.valeur.elements[0].completude.personnages).toBe('absents');
	});

	it('la suite est un numéro de page, et elle est rejouée', async () => {
		const { adaptateur, appels } = tmdb([{ quand: 'search/multi', corps: rechercheReelle }]);

		const premiere = await adaptateur.rechercher('Iron Man');
		if (!premiere.ok) throw new Error(premiere.motif);
		expect(premiere.valeur.suite).toBe('2');

		await adaptateur.rechercher('Iron Man', { suite: '2' });
		expect(appels[1]).toContain('page=2');
	});

	it('un jeton refusé est « non-autorisé », pas une panne', async () => {
		const { adaptateur } = tmdb([{ quand: 'search/multi', statut: 401 }]);

		expect(await adaptateur.rechercher('Iron Man')).toEqual({ ok: false, motif: 'non-autorise' });
	});
});

describe('lecture d’une fiche', () => {
	it('rattache un film à sa collection, et retient les métiers qu’un lecteur nomme', async () => {
		const { adaptateur } = tmdb([{ quand: 'movie/1726', corps: filmReel }]);

		const lue = await adaptateur.lireOeuvre('film:1726');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		expect(lue.valeur).toMatchObject({
			type: 'film',
			titre: 'Iron Man',
			serie: {
				reference: { source: 'tmdb', idExterne: 'collection:131292' },
				nom: 'Iron Man Collection'
			}
		});
		expect(lue.valeur.createurs.map((c) => c.role)).toContain('Director');
		// Le chef décorateur est au générique de TMDB, pas dans le catalogue : cent
		// quatre-vingts entités par film feraient exploser le volume du graphe.
		expect(lue.valeur.createurs.map((c) => c.role)).not.toContain('Production Design');
	});

	it('n’ingère jamais le casting comme des personnages', async () => {
		const { adaptateur } = tmdb([{ quand: 'movie/1726', corps: filmReel }]);

		const lue = await adaptateur.lireOeuvre('film:1726');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		// « Tony Stark » existe dans la réponse, mais l'identifiant qui l'accompagne
		// est celui de Robert Downey Jr. : le rattacher relierait tous ses rôles.
		expect(filmReel.credits.cast[0].character).toBe('Tony Stark');
		expect(lue.valeur.personnages).toEqual([]);
		expect(lue.valeur.completude.personnages).toBe('absents');
	});

	it('une série télévisée désigne sa propre entité de série', async () => {
		const { adaptateur } = tmdb([{ quand: 'tv/3097', corps: serieReelle }]);

		const lue = await adaptateur.lireOeuvre('serie:3097');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		expect(lue.valeur.serie).toEqual({
			reference: { source: 'tmdb', idExterne: 'serie:3097' },
			nom: 'Iron Man'
		});
	});

	it('un générique absent vaut indisponible : la sous-ressource n’a pas répondu', async () => {
		const { credits, ...sansCredits } = filmReel;
		expect(credits.crew.length).toBeGreaterThan(0);

		const { adaptateur } = tmdb([{ quand: 'movie/1726', corps: sansCredits }]);
		const lue = await adaptateur.lireOeuvre('film:1726');
		if (!lue.ok || lue.valeur === null) throw new Error('fiche illisible');

		expect(lue.valeur.completude.createurs).toBe('indisponibles');
	});

	it('un identifiant sans espace n’est pas lu au hasard', async () => {
		const { adaptateur, appels } = tmdb([]);

		expect(await adaptateur.lireOeuvre('1726')).toEqual({ ok: true, valeur: null });
		expect(appels).toEqual([]);
	});
});

describe('parcours par facette', () => {
	it('une collection rend ses films', async () => {
		const { adaptateur } = tmdb([{ quand: 'collection/131292', corps: collectionReelle }]);

		const trouvees = await adaptateur.parcourir('serie', 'collection:131292');
		if (!trouvees.ok) throw new Error(trouvees.motif);

		expect(trouvees.valeur.elements.map((oeuvre) => oeuvre.titre).sort()).toEqual([
			'Iron Man',
			'Iron Man 2',
			'Iron Man 3'
		]);
	});

	it('un axe non couvert rend une page vide plutôt qu’une dégradation', async () => {
		const { adaptateur, appels } = tmdb([]);

		expect(await adaptateur.parcourir('personnage', 'personne:3223')).toEqual({
			ok: true,
			valeur: { elements: [] }
		});
		expect(appels).toEqual([]);
	});
});

describe('capacités déclarées', () => {
	it('déclare ne pas savoir crédier les personnages, conformément à la mesure', () => {
		const { adaptateur } = tmdb([]);

		expect(adaptateur.capacites.personnagesParOeuvre).toBe(false);
		expect(adaptateur.capacites.parcoursParPersonnage).toBe(false);
		expect(adaptateur.typesCouverts).toEqual(['film', 'serie']);
	});
});
