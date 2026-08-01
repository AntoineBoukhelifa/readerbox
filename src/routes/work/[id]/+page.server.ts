import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { lireOeuvre } from '$lib/server/catalog/corrections';
import {
	abandonner,
	agregatDOeuvre,
	consigner,
	declarerPosition,
	ecrireAvis,
	lecteursDOeuvre,
	lireAvisDOeuvre,
	lireConsignation,
	modifierAvis,
	noter,
	reprendre,
	retirer,
	supprimerAvis,
	type MotifRefusJournal,
	type ProvenanceDeclaree
} from '$lib/server/journal/entries';
import { ETAGERES, type Etagere } from '$lib/server/journal/atteinte';
import type { SaisieDePosition } from '$lib/server/journal/position';
import {
	estOeuvreLongue,
	masquer,
	publicationAutorisee,
	reveler
} from '$lib/server/masking/visibility';
import { ordreProvenant } from '$lib/server/orders/orders';
import { referencesDEntites } from '$lib/server/catalog/recherche';
import type { Actions, PageServerLoad } from './$types';

/**
 * La page d'une œuvre : la première surface où le masquage se voit, et la seule
 * où la boucle centrale du produit se joue.
 *
 * Trois choses y cohabitent en lecture, et leur séparation est la règle du
 * produit :
 *
 * - **l'agrégat traverse toujours** (R28). Note moyenne, nombre de notes,
 *   nombre d'avis : rien de tout cela ne passe par le masquage, et c'est ce qui
 *   rend la règle unique vivable — un membre qui parcourt voit les notes
 *   partout, et les textes de ce qu'il a atteint.
 * - **les lecteurs traversent aussi** (R26). Qui a atteint l'œuvre, qui est en
 *   train de la lire, et où il en est.
 * - **les textes passent par `masquer`** (R27), et par lui seul. Ce qui sort
 *   d'ici ne contient pas les textes refusés : ils ne sont pas mis à `null`
 *   après coup dans le rendu, ils ne sont jamais entrés dans la charge utile.
 *   Un masquage appliqué côté client enverrait le texte au navigateur, ce qui
 *   n'est pas du masquage (KTD3).
 *
 * **Le texte de l'avis du membre lui-même passe par le même chemin** que les
 * autres, et n'est pas relu depuis sa consignation. Il ressort visible par le
 * premier des quatre chemins de `verdictDeVisibilite` — l'auteur voit toujours
 * ce qu'il a écrit — et c'est ce texte-là, et pas un autre, qui préremplit le
 * formulaire de modification. Une seconde source pour la même chaîne serait une
 * seconde règle en puissance.
 *
 * **Aucune écriture ici.** Les actions ci-dessous appellent `journal/entries.ts`,
 * seul module qui écrit dans le journal : c'est ce qui garantit que chaque geste
 * de cette page notifie le graphe (U9), le fil (U8) et les cascades (U5) sans
 * qu'aucune surface n'ait à y penser.
 */
export const load: PageServerLoad = async ({ params, url, locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	const db = getDb(d1);
	const membreId = locals.member.id;

	const oeuvre = await lireOeuvre(db, params.id);
	if (!oeuvre) error(404, 'Œuvre introuvable.');

	const consignation = await lireConsignation(db, membreId, oeuvre.id);

	/**
	 * R42 — l'ordre que la page annonce : celui **enregistré** dès qu'il y en a un,
	 * celui de l'URL sinon.
	 *
	 * L'ordre de préférence est celui du fait sur l'intention : la provenance ne se
	 * réécrit pas, donc afficher celle de l'URL par-dessus une consignation déjà
	 * provenante annoncerait quelque chose qui n'arrivera pas. Les deux passent par
	 * la même vérification — l'ordre doit exister et contenir l'œuvre — parce que
	 * l'ordre enregistré a pu perdre l'œuvre depuis, ou disparaître.
	 */
	const ordreEnregistre =
		consignation?.provenance.type === 'ordre' ? consignation.provenance.ordreId : null;

	const [agregat, lecteurs, avis, ordre] = await Promise.all([
		agregatDOeuvre(db, oeuvre.id),
		lecteursDOeuvre(db, oeuvre.id),
		lireAvisDOeuvre(db, oeuvre.id).then((contenus) => masquer(db, membreId, contenus)),
		ordreProvenant(db, ordreEnregistre ?? url.searchParams.get('depuis') ?? '', oeuvre.id)
	]);

	const monAvis = avis.find((contenu) => contenu.auteurId === membreId) ?? null;
	const longue = estOeuvreLongue(oeuvre.type);

	/**
	 * R46 — les rattachements de la fiche sont des portes vers l'amont.
	 *
	 * Chaque personnage et la série portent leur référence de source pour que la
	 * page de parcours puisse aller chercher les apparitions que le groupe n'a pas
	 * consignées. Sans cette référence, la découverte se refermerait sur le
	 * catalogue local — précisément ce que KTD1 interdit.
	 */
	const references = await referencesDEntites(db, [
		...oeuvre.personnages.map((personnage) => personnage.entityId),
		...(oeuvre.serie ? [oeuvre.serie.entityId] : []),
		...(oeuvre.event ? [oeuvre.event.entityId] : [])
	]);

	const facette = (entityId: string) => references.get(entityId) ?? null;

	return {
		oeuvre: {
			id: oeuvre.id,
			titre: oeuvre.titre,
			type: oeuvre.type,
			longue,
			dateDeParution: oeuvre.dateDeParution,
			serie: oeuvre.serie?.nom ?? null,
			serieFacette: oeuvre.serie ? facette(oeuvre.serie.entityId) : null,
			event: oeuvre.event?.nom ?? null,
			eventFacette: oeuvre.event ? facette(oeuvre.event.entityId) : null,
			couvertureUrl: oeuvre.couvertureUrl,
			numeroDansLaSerie: oeuvre.numeroDansLaSerie,
			/** L'état d'ingestion est affiché : une fiche incomplète le dit plutôt que de mentir par omission. */
			etatIngestion: oeuvre.etatIngestion
		},
		personnages: oeuvre.personnages.map((personnage) => ({
			entityId: personnage.entityId,
			nom: personnage.nom,
			facette: facette(personnage.entityId)
		})),
		agregat,
		// R38 — le nom d'un membre parti n'est pas remplacé au rendu : il n'est pas
		// envoyé. C'est la même discipline que pour les textes masqués, et pour la
		// même raison — ce qui n'est pas dans la charge utile ne peut pas fuir.
		lecteurs: lecteurs.map((lecteur) => ({
			...lecteur,
			nom: lecteur.parti ? null : lecteur.nom
		})),
		/**
		 * Où en est le membre connecté, tel que la page le rend évident d'un coup
		 * d'œil. L'abandon y est un champ à part et non une quatrième étagère : R2
		 * en fait un état distinct des trois, et l'afficher en quatrième colonne
		 * reviendrait à le nier.
		 */
		moi:
			consignation === null
				? {
						consignee: false as const,
						etagere: null,
						abandonnee: false,
						atteinte: false,
						position: 0,
						positionDeclaree: null,
						longueurTotale: null,
						note: null,
						avis: null,
						/** R10 — combien de recueils soutiennent l'entrée, pour dire ce qu'un retrait laisse. */
						recueils: 0,
						publicationPossible: publicationAutorisee({
							typeOeuvre: oeuvre.type,
							atteinte: false,
							positionDeclaree: null
						})
					}
				: {
						consignee: true as const,
						etagere: consignation.etagere,
						abandonnee: consignation.abandonnee,
						atteinte: consignation.atteinte,
						position: consignation.position,
						positionDeclaree: consignation.positionDeclaree,
						longueurTotale: consignation.longueurTotale,
						note: consignation.note,
						avis: monAvis === null ? null : { id: monAvis.id, texte: monAvis.texte ?? '' },
						recueils: consignation.recueils.length,
						// R25 — décidée par le masquage, seulement affichée ici.
						publicationPossible: publicationAutorisee({
							typeOeuvre: oeuvre.type,
							atteinte: consignation.atteinte,
							positionDeclaree: consignation.positionDeclaree
						})
					},
		/** R42 — `null` dès que l'ordre annoncé n'existe pas ou ne mène pas ici. */
		provenance:
			ordre === null
				? null
				: {
						ordreId: ordre.id,
						titre: ordre.titre,
						/** Déjà inscrite dans le journal, ou seulement annoncée par le lien ? */
						enregistree: ordre.id === ordreEnregistre
					},
		// La reconstruction est explicite plutôt qu'un `...avis` : ce qui part au
		// navigateur se lit ici, champ par champ.
		avis: avis.map((contenu) => ({
			id: contenu.id,
			oeuvreId: contenu.oeuvreId,
			auteur: {
				id: contenu.auteurId,
				nom: contenu.auteurParti ? 'Un membre parti' : contenu.auteurNom
			},
			mien: contenu.auteurId === membreId,
			note: contenu.note,
			ecritLe: contenu.ecritLe,
			masque: contenu.masque,
			texte: contenu.texte
		}))
	};
};

// ---------------------------------------------------------------------------
// Les refus, tels qu'ils s'affichent
// ---------------------------------------------------------------------------

const CODES: Record<MotifRefusJournal, number> = {
	'œuvre introuvable': 404,
	'membre introuvable': 404,
	'consignation introuvable': 404,
	'avis introuvable': 404,
	'note invalide': 400,
	'avis vide': 400,
	'avis déjà écrit': 400,
	'position requise': 400,
	'valeur invalide': 400,
	'hors bornes': 400,
	'longueur inconnue': 400
};

/**
 * Ce qu'un refus dit au membre.
 *
 * R25 est le seul qui mérite une phrase entière : c'est le refus qu'un membre
 * rencontre en voulant faire quelque chose de légitime — écrire ce qu'il pense
 * d'un roman qu'il n'a pas fini — et un « refusé : position requise » le
 * laisserait sans savoir quoi faire. Le message dit la règle **et** le geste qui
 * la satisfait.
 */
function message(motif: MotifRefusJournal): string {
	switch (motif) {
		case 'position requise':
			return 'Cette œuvre est longue et tu ne l’as pas atteinte : dis d’abord où tu en es — une position strictement positive — pour que ton avis ne soit servi qu’à ceux qui sont allés aussi loin que toi.';
		case 'consignation introuvable':
			return 'Pose d’abord cette œuvre sur une étagère.';
		case 'note invalide':
			return 'Une note va de 0,5 à 5 étoiles, par demi-étoiles.';
		case 'avis vide':
			return 'Un avis vide n’est pas un avis.';
		case 'avis déjà écrit':
			return 'Tu as déjà un avis sur cette œuvre : modifie-le plutôt.';
		case 'avis introuvable':
			return 'Tu n’as pas d’avis sur cette œuvre.';
		case 'longueur inconnue':
			return 'Pour saisir une page, dis aussi combien de pages compte ton édition.';
		case 'hors bornes':
			return 'Cette position tombe hors de l’œuvre.';
		case 'valeur invalide':
			return 'Cette position n’est pas un nombre.';
		default:
			return `Refusé : ${motif}.`;
	}
}

function refuser(motif: MotifRefusJournal) {
	return fail(CODES[motif], { message: message(motif) });
}

/**
 * Un nombre saisi par un membre, virgule comprise.
 *
 * « 12,5 » est ce qu'un clavier français produit, et le refuser comme « pas un
 * nombre » serait un refus incompréhensible pour qui a tapé exactement ce qu'on
 * lui demandait.
 */
function nombre(valeur: FormDataEntryValue | null): number | null {
	const texte = String(valeur ?? '')
		.trim()
		.replace(',', '.');
	if (texte === '') return null;
	const lu = Number(texte);
	return Number.isFinite(lu) ? lu : null;
}

/**
 * Le contexte commun de toutes les actions.
 *
 * **L'œuvre vient de l'URL et le membre de la session**, jamais du formulaire.
 * C'est ce qui rend structurellement impossible d'agir sur la consignation d'un
 * autre : U4 désigne ses opérations par le couple membre-œuvre, et ce couple est
 * ici entièrement composé de valeurs qu'un membre ne peut pas forger. Aucune
 * action de cette page ne lit d'identifiant de membre, d'entrée ni d'avis.
 */
async function contexte(evenement: {
	locals: App.Locals;
	platform?: Readonly<App.Platform> | undefined;
	params: { id: string };
	request: Request;
}) {
	const d1 = evenement.platform?.env?.DB;
	if (!d1 || !evenement.locals.member) return null;

	return {
		db: getDb(d1),
		membreId: evenement.locals.member.id,
		oeuvreId: evenement.params.id,
		champs: await evenement.request.formData()
	};
}

const REFUS_SANS_SESSION = { message: 'Session requise.' };

function estEtagere(valeur: string): valeur is Etagere {
	return (ETAGERES as readonly string[]).includes(valeur);
}

export const actions: Actions = {
	/**
	 * R1 — poser l'œuvre sur une étagère, ou l'y déplacer.
	 *
	 * **R42, la provenance.** Elle est annoncée par un champ que le membre peut
	 * forger, et elle est donc revérifiée ici comme au chargement : l'ordre doit
	 * exister et contenir cette œuvre. Une prétention invérifiable ne fait pas
	 * échouer la consignation — le membre voulait consigner, et il consigne —
	 * elle retombe simplement sur le catalogue, qui est la vérité par défaut.
	 * `consigner` ne réécrit de toute façon jamais la provenance d'une entrée
	 * existante.
	 */
	consigner: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const demandee = String(ctx.champs.get('etagere') ?? '');
		if (!estEtagere(demandee)) return fail(400, { message: 'Étagère inconnue.' });

		const ordre = await ordreProvenant(
			ctx.db,
			String(ctx.champs.get('depuis') ?? ''),
			ctx.oeuvreId
		);
		const provenance: ProvenanceDeclaree =
			ordre === null ? { type: 'catalogue' } : { type: 'ordre', ordreId: ordre.id };

		const resultat = await consigner(ctx.db, {
			membreId: ctx.membreId,
			oeuvreId: ctx.oeuvreId,
			etagere: demandee,
			provenance
		});
		return resultat.ok ? { fait: true } : refuser(resultat.motif);
	},

	/** R2 — l'abandon, quatrième état distinct des trois étagères. */
	abandonner: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const resultat = await abandonner(ctx.db, {
			membreId: ctx.membreId,
			oeuvreId: ctx.oeuvreId
		});
		return resultat.ok ? { fait: true } : refuser(resultat.motif);
	},

	/** R35 — reprendre : l'œuvre repasse en cours et cesse d'être atteinte. */
	reprendre: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const resultat = await reprendre(ctx.db, {
			membreId: ctx.membreId,
			oeuvreId: ctx.oeuvreId
		});
		return resultat.ok ? { fait: true } : refuser(resultat.motif);
	},

	/**
	 * R33 — retirer la consignation, note et avis emportés.
	 *
	 * Le message dit ce qui vient d'être perdu, et le cas de R34 — l'entrée reste
	 * parce qu'un recueil la soutient toujours — est annoncé plutôt que constaté :
	 * un membre qui retire une consignation et voit l'œuvre encore là croirait à
	 * un bug.
	 */
	retirer: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const resultat = await retirer(ctx.db, { membreId: ctx.membreId, oeuvreId: ctx.oeuvreId });
		if (!resultat.ok) return refuser(resultat.motif);

		const emporte = [
			resultat.noteSupprimee ? 'ta note' : null,
			resultat.avisSupprime ? 'ton avis' : null
		].filter((mot): mot is string => mot !== null);

		return {
			fait: true,
			message: resultat.entreeConservee
				? `Ta consignation est retirée${emporte.length > 0 ? `, avec ${emporte.join(' et ')}` : ''}. L’œuvre reste dans ton journal : un recueil que tu lis la contient.`
				: `Consignation retirée${emporte.length > 0 ? `, avec ${emporte.join(' et ')}` : ''}.`
		};
	},

	/** R23 — déclarer où l'on en est, en page ou en pourcentage. La fraction est calculée par `position.ts`. */
	position: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const valeur = nombre(ctx.champs.get('valeur'));
		if (valeur === null) return refuser('valeur invalide');

		const enPages = String(ctx.champs.get('unite') ?? 'pourcentage') === 'page';
		const longueur = nombre(ctx.champs.get('longueur'));
		const saisie: SaisieDePosition = enPages
			? { unite: 'page', valeur, longueurTotale: longueur }
			: { unite: 'pourcentage', valeur };

		const resultat = await declarerPosition(ctx.db, {
			membreId: ctx.membreId,
			oeuvreId: ctx.oeuvreId,
			saisie
		});
		return resultat.ok ? { fait: true } : refuser(resultat.motif);
	},

	/** R4 — noter en demi-étoiles. */
	noter: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const note = nombre(ctx.champs.get('note'));
		if (note === null) return refuser('note invalide');

		const resultat = await noter(ctx.db, {
			membreId: ctx.membreId,
			oeuvreId: ctx.oeuvreId,
			note
		});
		return resultat.ok ? { fait: true } : refuser(resultat.motif);
	},

	/** R37 — retirer sa note sans rien perdre d'autre. */
	retirerNote: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const resultat = await noter(ctx.db, {
			membreId: ctx.membreId,
			oeuvreId: ctx.oeuvreId,
			note: null
		});
		return resultat.ok ? { fait: true } : refuser(resultat.motif);
	},

	/** R5 — écrire son avis. R25 est appliqué par `entries.ts` et décidé par le masquage. */
	ecrireAvis: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const texte = String(ctx.champs.get('texte') ?? '');
		const resultat = await ecrireAvis(ctx.db, {
			membreId: ctx.membreId,
			oeuvreId: ctx.oeuvreId,
			texte
		});
		// La saisie est rendue avec le refus : un avis refusé pour absence de
		// position ne doit pas être à retaper.
		return resultat.ok
			? { fait: true }
			: fail(CODES[resultat.motif], { message: message(resultat.motif), texte });
	},

	/**
	 * R37 — modifier son propre avis.
	 *
	 * **L'avis n'est pas désigné par son identifiant**, bien que R37 le nomme
	 * ainsi et que `modifierAvis` en vérifie la propriété : la page le retrouve
	 * par le couple membre-œuvre, qu'un membre ne peut pas forger. Un identifiant
	 * d'avis dans le formulaire serait une seconde porte à surveiller pour rien.
	 */
	modifierAvis: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const texte = String(ctx.champs.get('texte') ?? '');
		const consignation = await lireConsignation(ctx.db, ctx.membreId, ctx.oeuvreId);
		if (consignation === null || consignation.avis === null) return refuser('avis introuvable');

		const resultat = await modifierAvis(ctx.db, {
			membreId: ctx.membreId,
			avisId: consignation.avis.id,
			texte
		});
		return resultat.ok
			? { fait: true }
			: fail(CODES[resultat.motif], { message: message(resultat.motif), texte });
	},

	/** R37 — supprimer son avis, sans perdre ni sa consignation ni sa note. */
	supprimerAvis: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const consignation = await lireConsignation(ctx.db, ctx.membreId, ctx.oeuvreId);
		if (consignation === null || consignation.avis === null) return refuser('avis introuvable');

		const resultat = await supprimerAvis(ctx.db, {
			membreId: ctx.membreId,
			avisId: consignation.avis.id
		});
		return resultat.ok ? { fait: true } : refuser(resultat.motif);
	},

	/**
	 * R31 — la révélation est un aller-retour serveur, jamais un basculement côté
	 * client. Puisque le texte n'est pas dans la charge utile, il n'y a rien à
	 * dévoiler côté navigateur : le bouton **demande** le texte, le serveur
	 * enregistre la révélation, et la page rechargée le contient enfin.
	 *
	 * **L'œuvre vient de l'URL et le membre de la session.** Ni l'un ni l'autre
	 * n'est lu du formulaire : il n'y a donc aucun identifiant à forger pour
	 * révéler au nom d'un autre.
	 */
	reveler: async ({ params, locals, platform }) => {
		const d1 = platform?.env?.DB;
		if (!d1 || !locals.member) return fail(401, { message: 'Session requise.' });

		const resultat = await reveler(getDb(d1), {
			membreId: locals.member.id,
			oeuvreId: params.id
		});
		if (!resultat.ok) return fail(404, { message: 'Œuvre introuvable.' });

		return { revele: true };
	}
};
