import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	lireFil,
	marquerNotificationsLues,
	notificationsDe,
	type ProvenanceDuFil
} from '$lib/server/feed/events';
import { LIBELLE_SANS_TYPE, masquerTitres, type TitreDuFil } from '$lib/server/masking/visibility';
import type { Actions, PageServerLoad } from './$types';

/**
 * Le fil du groupe (R41), et ce qui y arrive à un membre en particulier (R43).
 *
 * **Trois règles se croisent ici, et aucune n'est décidée dans ce fichier.**
 *
 * - **R32 — le titre.** Il est masqué pour un membre qui a placé l'œuvre sur son
 *   étagère « à découvrir », et visible partout ailleurs. La décision appartient
 *   à `masking/visibility.ts`, comme celle de R27 : deux fichiers qui décideraient
 *   chacun de ce qu'on voit, c'est exactement le défaut que KTD5 existe pour
 *   prévenir. La page reçoit un libellé et l'affiche — elle ne sait même pas ce
 *   qu'elle n'affiche pas, puisqu'un titre masqué n'est pas dans ce qu'elle reçoit.
 * - **Le texte des avis n'est pas ici.** Pas « masqué » : absent. Un événement de
 *   type avis dit qu'un avis a été écrit, et `feed_events` n'a aucune colonne
 *   capable d'en porter le texte. Qui veut le lire ouvre la page de l'œuvre, où
 *   R27 décide — et refuse tant que l'œuvre n'est pas atteinte. Aucune charge
 *   utile servie par cette route ne peut donc en contenir un, même par erreur.
 * - **R38 — le nom.** Un membre parti n'est pas nommé, et `lireFil` ne charge
 *   même pas son nom d'affichage : ce qui n'est pas lu ne peut pas fuir.
 *
 * **R42 — la provenance** accompagne les seules consignations, parce que c'est
 * d'elles que R42 parle : « une œuvre consignée conserve et affiche sa
 * provenance ». La répéter sur chaque avancement de la même œuvre ne dirait rien
 * de plus et noierait le reste.
 */

/** Ce qu'on affiche à la place d'un nom qu'on ne doit plus dire (R38). */
const MEMBRE_PARTI = 'Un membre parti';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	const db = getDb(d1);
	const lecteurId = locals.member.id;

	const [evenements, notifications] = await Promise.all([
		lireFil(db),
		notificationsDe(db, lecteurId)
	]);

	// Les deux listes passent par la **même** règle : un fil qui protégerait un
	// titre que la notification d'à côté révélerait ne protégerait rien.
	const evenementsCibles = evenements.filter((evenement) => evenement.oeuvre !== null);
	const notificationsCibles = notifications.filter((notification) => notification.oeuvre !== null);

	const [titresDuFil, titresDesNotifications] = await Promise.all([
		masquerTitres(
			db,
			lecteurId,
			evenementsCibles.map((evenement) => ({
				oeuvreId: evenement.oeuvre!.id,
				titre: evenement.oeuvre!.titre,
				acteurId: evenement.acteur.id
			}))
		),
		masquerTitres(
			db,
			lecteurId,
			notificationsCibles.map((notification) => ({
				oeuvreId: notification.oeuvre!.id,
				titre: notification.oeuvre!.titre,
				acteurId: notification.acteur.id
			}))
		)
	]);

	const parEvenement = new Map(
		evenementsCibles.map((evenement, rang) => [evenement.id, titresDuFil[rang]])
	);
	const parNotification = new Map(
		notificationsCibles.map((notification, rang) => [notification.id, titresDesNotifications[rang]])
	);

	return {
		// La reconstruction est explicite plutôt qu'un `...evenement` : ce qui part
		// au navigateur se lit ici, champ par champ.
		evenements: evenements.map((evenement) => ({
			id: evenement.id,
			type: evenement.type,
			acteur: evenement.acteur.nom ?? MEMBRE_PARTI,
			oeuvre: affichage(evenement.oeuvre?.id ?? null, parEvenement.get(evenement.id)),
			ordre: evenement.ordre,
			etagere: evenement.etagere,
			note: evenement.note,
			position: evenement.position,
			provenance: libelleDeProvenance(evenement.provenance),
			quand: evenement.quand
		})),
		notifications: notifications.map((notification) => ({
			id: notification.id,
			acteur: notification.acteur.nom ?? MEMBRE_PARTI,
			oeuvre: affichage(notification.oeuvre?.id ?? null, parNotification.get(notification.id)),
			nombreDOeuvres: notification.nombreDOeuvres,
			quand: notification.quand
		}))
	};
};

/**
 * L'œuvre telle qu'une ligne l'affiche.
 *
 * Une œuvre disparue du catalogue — fusion de doublons — se lit « une œuvre » :
 * le fait rapporté a bien eu lieu, et un trou serait plus déroutant qu'un mot.
 */
function affichage(
	oeuvreId: string | null,
	titre: TitreDuFil | undefined
): { id: string | null; libelle: string; masque: boolean } {
	if (titre === undefined) return { id: oeuvreId, libelle: LIBELLE_SANS_TYPE, masque: false };
	return { id: oeuvreId, libelle: titre.libelle, masque: titre.masque };
}

/** R42 — la provenance en une phrase, ou rien quand elle n'a pas lieu d'être dite. */
function libelleDeProvenance(
	provenance: ProvenanceDuFil | null
): { libelle: string; ordreId: string | null } | null {
	if (provenance === null) return null;

	if (provenance.type === 'membre') {
		return {
			libelle: `sur la recommandation de ${provenance.nom ?? 'un membre parti'}`,
			ordreId: null
		};
	}

	if (provenance.type === 'ordre') {
		return {
			libelle: `depuis l’ordre ${provenance.titre ?? 'd’un membre'}`,
			ordreId: provenance.ordreId
		};
	}

	return { libelle: 'depuis le catalogue', ordreId: null };
}

export const actions: Actions = {
	/**
	 * R43 — le membre a vu ce qui le concerne.
	 *
	 * **Le membre est celui de la session**, comme pour la révélation de R31 : il
	 * n'y a aucun identifiant à forger pour vider la liste de quelqu'un d'autre.
	 */
	lu: async ({ locals, platform }) => {
		const d1 = platform?.env?.DB;
		if (!d1 || !locals.member) return fail(401, { message: 'Session requise.' });

		await marquerNotificationsLues(getDb(d1), locals.member.id);
		return { lu: true };
	}
};
