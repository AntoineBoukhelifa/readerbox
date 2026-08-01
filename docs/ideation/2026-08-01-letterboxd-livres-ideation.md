---
date: 2026-08-01
topic: letterboxd-pour-les-livres
focus: un SaaS de catalogage social du livre, marché francophone, greenfield
scope: usage personnel et cercle d'amis — questions économiques explicitement hors périmètre (2026-08-01)
mode: elsewhere-software
---

# Idéation : un « Letterboxd pour les livres » en SaaS

42 idées brutes générées par 6 cadres d'idéation parallèles, dédoublonnées puis filtrées.
7 survivantes. Candidats bruts et motifs de rejet conservés.

## Contexte d'ancrage

**Contexte du sujet.** Projet greenfield total : aucun code, aucun brief, aucune maquette. Utilisateur francophone, marché FR/EU. Le contexte est donc entièrement externe — deux passes de recherche ont fourni la matière ci-dessous.

**Letterboxd, mécaniques exactes.** Diary chronologique + Lists = les deux briques fondatrices. La review courte au ton « critique amateur » est devenue un genre mémétique depuis 2018 et circule hors plateforme. 4 favoris de profil = identité culturelle condensée. Pro 19 $/an, Patron 49 $/an — du mécénat, pas un paywall. 26 M+ utilisateurs début 2026, ~700 M de notes. Rachat Tiny 2023 pour 3,62 M$ (~60 %) ; **en mai 2026 Tiny cherche déjà à revendre** — même 26 M d'utilisateurs ne produisent pas un multiple satisfaisant. Le paradoxe : la base qui fait la valeur culturelle empêche de monétiser agressivement.

**Concurrence.** _Goodreads_ : incumbent Amazon, stagnant depuis 10+ ans ; fuite motivée par la stagnation, la défiance Amazon, la suppression des messages privés fin 2025-2026, et un catalogue sale (doublons d'éditions, ASIN dupliqués par bots, page count à 0) ; API fermée depuis 2020, seul l'export CSV manuel subsiste. _StoryGraph_ : bootstrap, 5 M utilisateurs en janvier 2026, Plus à 4,99 $/mois, axe analytics — mais **son feed social est décrit comme « un parking abandonné »** pour un nouvel arrivant. _Hardcover_ : Letterboxd-like, API GraphQL ouverte, revenus publics, 100 % gratuit, pas d'app native, soutenabilité ouverte. _Fable_ : book clubs + lecteur intégré + flux « qui lit ça en ce moment ». _Literal_ : mort de fait (aucune update 2023-2024, CTO et lead eng partis). _Bookwyrm_ : ActivityPub, fragmenté par design, cold-start doublé. _Babelio_ : leader FR, 1,1 M utilisateurs actifs, devenu un « tremplin incontournable » de promotion éditoriale. _Livraddict_ : meilleure gestion éditions/séries, audience faible. _Basmo/Bookly/Bookmory_ : trackers à timer, zéro social.

**Échecs documentés.** _Tome_ (fermé 29 mai 2026, 100 k lecteurs) : coûts d'infra trop élevés pour un social riche en médias + marché trop encombré. _Slice Bookshelf_ (2014, backé Eric Schmidt) : pas d'app native 18 mois après le web. _TBR_ fermé juin 2026. Pattern : infra sociale coûteuse sans revenu proportionnel, et mobile trop tardif.

**La différence structurelle film vs livre — le cœur du problème.** Cinéphile actif : 200-500 films. Lecteur actif : 20-40 livres/an → graphe de co-consommation ~10x moins dense. Le film sort en salle (référent partagé à l'instant T), le livre se lit en asynchrone sur des mois → pas de pic collectif hors BookTok. L'abandon est fréquent (cause n°1 « lent et ennuyeux », 46,4 % ; écriture faible 18,8 %). L'état « en cours » dure des semaines. Formats papier/ebook/audio non résolus cross-format par personne. Les couvertures sont moins iconiques qu'une affiche et varient par édition.

**Métadonnées.** Problème Work vs Edition : une Œuvre, N Éditions. Racine du catalogue sale de Goodreads. Analogies : MusicBrainz (recording/release/release-group), Discogs (master/release), FRBR (Œuvre → Expression → Manifestation → Item). Sources : Open Library (gratuite, qualité inégale, crawl massif interdit → cache obligatoire), Google Books (~2x plus d'œuvres, couverture FR faible), ISBNdb (payant), Hardcover GraphQL.

**Économie.** Ce qui fait payer sur un log social gratuit : jamais le logging de base — toujours les insights perso, le statut/badge, l'accès prioritaire à une friction, ou la suppression des limites. Untappd prouve que le vrai argent est B2B (~20 000 établissements payants dans 75 pays). Backloggd : solo founder financé au Patreon. Goodreads : ~25 % du revenu par affiliation Amazon, contre-modèle non réplicable. Trakt : hausse VIP 30→60 $/an en 2025 avec suppression des tarifs legacy, controverse. Affiliation : Bookshop.org 10 % non-libraires / 30 % libraires, ~150 M$ générés pour les indés US ; **pas d'équivalent en France** ; Fnac via Awin plafonne à 5 % sur le livre. NetGalley : 575 $/6 mois de listing, abonnements dès ~6 000 $/an. Letterboxd a passé 9 ans en niche pure avant l'explosion.

**Culturel et légal.** BookTok : 36 M+ vidéos, 200 milliards de vues — le pic de désirabilité se fabrique hors plateforme. Jeunes FR 2026 : 18 min/jour de lecture loisir contre 3 h 01 d'écrans. RGPD art. 9 : un historique de lecture peut révéler religion, orientation politique, sexualité, santé mentale → sensible par inférence, consentement explicite plutôt qu'intérêt légitime. Modération : review bombing et extorsion d'auteurs sur Goodreads, ciblant disproportionnellement les auteurs marginalisés ; l'algo qui remonte les reviews les plus likées amplifie mécaniquement le toxique. Spoiler : plus aigu que pour le film ; les status updates échappent au tag chez Goodreads, trou non résolu chez StoryGraph non plus.

## Axes du sujet

1. **Catalogue & identité du livre** — Œuvre / Édition / Traduction / Format, qualité et fusion des métadonnées
2. **Boucle de lecture solo** — progression, abandon, journal, multi-format, stats perso
3. **Couche sociale & partageabilité** — reviews, feed, lecture synchrone, spoilers, modération, objet viral hors-plateforme
4. **Découverte & recommandation** — cold-start data, listes vs notes, signal externe, libraires
5. **Amorçage & économie** — import Goodreads, niche de départ, consumer-pay vs B2B, affiliation FR, coûts d'infra

## Recadrage — périmètre « moi et mes amis »

Précision apportée après le premier classement : le produit visé est un SaaS d'usage personnel, partageable avec un cercle d'amis. **Les questions économiques sont hors périmètre.**

Ça invalide une partie des arbitrages ci-dessous, parce que deux hypothèses tombent :

- **Le cold-start disparaît.** La moitié des raisonnements du classement initial servaient à répondre à « comment remplir un feed vide quand personne ne se connaît ». Quand les dix premiers utilisateurs sont des amis, le graphe social est donné, pas à construire. Les stratégies d'amorçage (niche manga, prescription libraire, index de tendances) perdent leur justification principale.
- **La monétisation disparaît.** Tout ce qui existait pour découpler le revenu du volume d'utilisateurs sort du périmètre.

En revanche, **rien de ce qui touche au modèle de données ne change** : les décisions structurantes restent structurantes, parce qu'elles coûtent cher à défaire, quel que soit le nombre d'utilisateurs.

### Classement révisé pour ce périmètre

| Rang | Idée                                                                   | Statut après recadrage                                                                                                                                                                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **L'ancrage positionnel** (idée 1)                                     | **Renforcée.** L'argument « densité en cumul plutôt qu'en simultané » vaut _davantage_ à petite échelle : c'est ce qui fait qu'un produit à 8 utilisateurs a quand même du contenu à afficher                                                                                                                                   |
| 2    | **La liste adressée / mixtape** (rejet n°9)                            | **Promue de justesse à tête de liste.** L'unicast fonctionne dès deux utilisateurs — c'est littéralement le cas d'usage « je partage avec mes amis ». Elle n'était sortie que faute d'enjeu structurel                                                                                                                          |
| 3    | **L'intention comme donnée principale** (idée 6)                       | **Conservée, amputée.** La PAL publique, la provenance de l'envie et le crédit d'attribution sont exactement la boucle de recommandation entre amis. L'index hebdomadaire « ce qui monte » sort — il exige de l'échelle                                                                                                         |
| 4    | **Le cycle synchronisé façon Daf Yomi** (rejet n°10)                   | **Promue.** « On lit tous la même chose en même temps » est une mécanique de groupe d'amis avant d'être une mécanique de masse, et elle fabrique le moment collectif à n'importe quelle taille                                                                                                                                  |
| 5    | **Modèle Œuvre / Expression / Manifestation propre** (idée 3, réduite) | **Conservée, réduite.** L'argument de fossé concurrentiel tombe ; l'argument de dette technique reste entier — se tromper de modèle coûte une migration douloureuse à trois ans. Le socle BnF et le registre d'événements deviennent optionnels, le traducteur comme entité reste un plaisir de lecteur francophone peu coûteux |
| 6    | **La visibilité granulaire par livre** (rejet n°11)                    | **Promue.** Partager avec des amis rend le réglage par livre _plus_ pertinent, pas moins — ce sont précisément les gens dont on ne veut pas que tout soit visible. Et le RGPD s'applique quel que soit le nombre d'utilisateurs                                                                                                 |
| 7    | **Le classement par duels** (idée 7)                                   | **Conservée, re-justifiée.** La défense anti-review-bombing devient sans objet ; restent le signal de recommandation dense et l'objet de profil partageable, qui suffisent                                                                                                                                                      |

### Sorties du périmètre

| Idée                                                                    | Motif                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le libraire indépendant comme client payant (idée 4)                    | Purement économique. Le consensus le plus fort de la session, mais il répond à une question hors périmètre                                                                         |
| Le B2B de la courbe d'abandon (idée 5, moitié aval)                     | Idem. La moitié amont — abandon inféré, pas de honte du DNF — reste bonne pour un usage perso, mais la courbe de survie agrégée est du bruit statistique à dix lecteurs            |
| Amorcer sur le manga et la BD (idée 2)                                  | La justification était le cold-start et la densité de graphe, tous deux résolus par le cercle d'amis. Reste un choix de goût : légitime si vous lisez du manga, plus une stratégie |
| Socle BnF / Dilicom / catalogue en open data (idée 3, moitié fossé)     | Investissement de différenciation concurrentielle. Un appel à Open Library avec cache suffit à ce périmètre                                                                        |
| L'index hebdomadaire « ce qui monte en français » (idée 6, moitié aval) | Exige un volume d'utilisateurs pour produire un signal                                                                                                                             |

Les fiches détaillées ci-dessous restent inchangées et valables — elles décrivent chaque idée dans son ambition maximale. Le tableau ci-dessus dit laquelle mérite votre attention _maintenant_.

## Idées classées

### 1. L'ancrage positionnel comme primitive du produit

**Description.** Aucun contenu ne peut exister sans être ancré à une position normalisée dans l'œuvre — review, note de marge, citation, réaction, question. Le feed d'un livre n'est pas chronologique, c'est un axe : tu ne vois que ce qui a été écrit à une position ≤ la tienne. La review de fin de lecture devient le cas particulier « post à 100 % », pas le geste central. La position est normalisée cross-édition et cross-format (page papier d'une édition donnée, pourcentage ebook, timestamp audio).

**Axe.** 3 — Couche sociale & partageabilité

**Base.** `external:` SoundCloud ancre au timecode, Genius à la ligne, Wattpad au paragraphe — et Wattpad en tire un volume de conversation sans commune mesure avec la taille de son catalogue. Kindle Popular Highlights agrège par locator, pas par livre. Les read-alongs Reddit par chapitre sont la version artisanale du même mécanisme. Aucun catalogueur de livres n'a importé ce modèle : tous ont copié le review-après-coup hérité du film. `direct:` en appui — « Goodreads masque les reviews mais les status updates échappent au tag — trou structurel connu, non résolu chez StoryGraph non plus. »

**Justification.** Une seule décision d'architecture règle trois problèmes distincts. (a) Le spoiler cesse d'être un tag déclaratif — donc un coût de modération et un trou qui se rouvre à chaque nouvelle surface — pour devenir une inégalité au niveau du stockage : `pos(contenu) ≤ pos(lecteur)`. (b) Le réservoir de contenu social se multiplie : un lecteur produit 20-40 événements/an si l'atome est le livre fini, mais un événement par session s'il est la position — soit 10 à 50x plus de matière, exactement ce qui manque au « parking abandonné » de StoryGraph. (c) **Et l'effet le plus fort : ça désynchronise le social du temps réel.** Un lecteur de 2029 à la page 120 croise un lecteur de 2026 à la page 120. Le graphe n'a plus besoin d'être dense en simultané, il devient dense en cumul — c'est la seule réponse structurelle au « pas de pic collectif », et un actif qui grossit tout seul au lieu d'expirer comme un feed chronologique. Bonus : du texte court indexé par un entier, l'exact inverse du média riche qui a tué Tome.

**Contreparties.** La normalisation de position cross-édition et cross-format est un vrai problème d'ingénierie, à résoudre avant la première ligne de schéma — et elle dépend de la qualité de la pagination par édition, qui est précisément la métadonnée la plus sale du domaine. Un fil non chronologique est aussi une gageure d'UX : il faut le rendre lisible en trois secondes. Et rendre la review de fin structurellement secondaire va à l'encontre de ce que les gens viennent écrire.

**Confiance.** 80 % · **Complexité.** Élevée · **Statut.** Explorée — brainstorm engagé le 2026-08-01

_Convergence : 4 cadres indépendants sur 6 sont arrivés à cette idée._

---

### 2. Amorcer sur le manga et la BD, pas sur la littérature

**Description.** Bêta volontairement restreinte au manga, à la BD franco-belge et aux comics. Entité Série → Tome native, log d'un tome en un geste, calendrier des sorties FR, fil par série. Le roman n'arrive qu'en phase 2, une fois le graphe chaud.

**Axe.** 5 — Amorçage & économie

**Base.** `reasoned:` Les trois handicaps structurels du livre face au film sont arithmétiques, et le manga les casse tous les trois. (1) _Densité_ : un lecteur de manga consomme 100 à 400 tomes par an — autant ou plus qu'un cinéphile actif (200-500 films), là où le lecteur de romans plafonne à 20-40. Le graphe de co-consommation revient au niveau du film. (2) _Synchronicité_ : un tome sort à date fixe, chez tous les libraires le même jour — le référent culturel partagé à l'instant T, la propriété exacte sur laquelle Letterboxd repose et que le roman n'a pas. (3) _État intermédiaire_ : un tome se lit en 40 minutes, donc le « en cours » de plusieurs semaines s'effondre. `direct:` en appui — la France est le deuxième marché mondial du manga après le Japon, et Livraddict est explicitement cité comme ayant « une meilleure gestion éditions/séries que Babelio », c'est-à-dire que la douleur série/tome est un point de friction reconnu et mal servi.

**Justification.** C'est la seule décision qui neutralise **mécaniquement** les handicaps structurels au lieu de les compenser par du design. On ne choisit pas la niche pour sa taille mais pour sa densité de graphe et sa synchronicité — les deux variables dont dépend le fonctionnement du produit. C'est aussi le point aveugle de Babelio, tourné littérature et prescription éditoriale, et le terrain où Goodreads est le plus humiliant (110 entrées à saisir à la main pour One Piece, doublons d'édition à chaque tome). Coût quasi nul : c'est un choix de périmètre, pas un chantier technique.

**Contreparties.** On renonce au public « prix littéraires » au démarrage et on se fait étiqueter app pour ados pendant deux ans — c'est le prix qu'a payé Letterboxd en version niche 2011-2020, à espérer en accéléré. Le passage du manga au roman n'est pas garanti : la communauté acquise peut refuser l'élargissement, ou le produit peut se retrouver enfermé dans un segment plus petit que le marché visé.

**Confiance.** 75 % · **Complexité.** Faible · **Statut.** Non explorée

---

### 3. Le traducteur et l'Expression comme entités de première classe, sur socle BnF

**Description.** Modèle FRBR strict où l'**Expression** — le couple (œuvre, langue, traduction) — est l'unité notable, pas l'Œuvre abstraite ni l'ISBN. On ne lit pas « Dune », on lit la traduction Demuth ou la nouvelle. Le traducteur obtient une page-entité, des followers, une bibliographie et des notes, exactement comme le réalisateur chez Letterboxd ; le profil peut exposer « mes 4 traducteurs » à côté de « mes 4 livres ». Le socle d'autorité n'est ni Open Library ni Google Books mais les référentiels professionnels français : data.bnf.fr, identifiants ARK, notices d'autorité issues du dépôt légal, en Licence Ouverte. Le catalogue est tenu en registre d'événements — chaque fusion est signée, attribuée et **réversible**, et l'ancien identifiant survit en redirection permanente.

**Axe.** 1 — Catalogue & identité du livre

**Base.** `direct:` « Une Œuvre, N Éditions… c'est la racine du catalogue sale de Goodreads », et « Google Books : couverture FR faible » — les deux sources gratuites disponibles sont mauvaises précisément sur le marché visé. `external:` FamilySearch Family Tree (fusion/défusion native, identifiants persistants après fusion), MusicBrainz et Discogs (soumissions communautaires versionnées devenues le référentiel de facto que des tiers consomment), les ARK de la BnF conçus pour ne jamais se casser. Sur le traducteur : #TranslatorsOnTheCover (Jennifer Croft / Society of Authors, 2021) et le travail de l'ATLF ont fait de son invisibilité une revendication professionnelle publique.

**Justification.** Deux gestes qui composent. D'abord, la distinction Œuvre/Expression est traitée partout comme une dette technique pénible ; la retourner en **surface identitaire et sociale** est le geste. Un lecteur anglophone n'a pas besoin de cette couche — pour lui l'Expression se confond avec l'Œuvre — donc aucun acteur anglophone-first ne la construira jamais : c'est une donnée qui n'existera pas ailleurs _par construction_, pas par avance temporelle. Un lecteur francophone, lui, lit ~40 % d'œuvres traduites et _choisit_ sa traduction (Dostoïevski Markowicz, les retraductions de Kafka, d'Homère). Ensuite, la racine du catalogue sale n'est pas l'absence de modèle Œuvre/Édition — c'est que la fusion est irréversible, donc redoutée, donc la correction se gèle. Rendre la fusion annulable transforme la modération de données d'un acte risqué en acte routinier, et l'alias permanent garantit qu'aucun log de lecteur ne pointe jamais dans le vide. Effet secondaire : le référentiel « quelle traduction lire » répond à une requête sans réponse sérieuse en ligne aujourd'hui, et crée une communauté d'alliés naturels (traducteurs, éditeurs indépendants, universitaires) au moment exact où on a besoin d'ambassadeurs sans budget marketing.

**Contreparties.** C'est un socle de métadonnées lourd et franco-français qui ne se réplique pas tel quel si on ouvre l'Allemagne ou l'Espagne. Question d'affichage non triviale : si la même œuvre porte quatre notes selon le traducteur, laquelle gagne la page par défaut ? Et l'event-sourcing du catalogue est un coût d'ingénierie réel au moment où il faudrait aller vite.

**Confiance.** 70 % · **Complexité.** Élevée · **Statut.** Non explorée

_Convergence : 4 cadres sur le traducteur, 2 sur le catalogue événementiel._

---

### 4. Le libraire indépendant comme client payant, pas le lecteur

**Description.** Le produit reste gratuit et sans publicité pour les lecteurs. Le revenu vient d'un abonnement libraire : la table du libraire devient un objet natif (liste signée, revendiquée, suivable), une étiquette de rayon avec code scannable ajoute le livre au journal du lecteur en deux secondes sans compte préalable, et le libraire reçoit des statistiques de prescription — quels livres il a fait lire, et la PAL agrégée anonymisée de sa zone de chalandise.

**Axe.** 5 — Amorçage & économie

**Base.** `direct:` « Untappd : le vrai argent est B2B — ~20 000 bars/brasseries payantes dans 75 pays. Analogie livre : éditeurs/libraires plutôt que lecteurs » et « pas d'équivalent Bookshop.org en France — angle de différenciation net ». `external:` la loi Lang de 1981 impose le prix unique du livre avec une remise plafonnée à 5 % : **aucune librairie française ne peut concurrencer par le prix.** Le seul champ de concurrence que la loi laisse ouvert est la prescription. Corollaire immédiat : l'affiliation à la commission — modèle de Goodreads (~25 % du revenu) et de Bookshop.org — est structurellement faible ici, Fnac plafonnant à 5 % sur un panier faible.

**Justification.** Si le prix est verrouillé par la loi, la seule valeur captable dans la chaîne française est la prescription — un produit qui la rend mesurable et transportable attaque donc l'unique levier différenciant du libraire, et le fait au moment où Babelio est en conflit d'intérêts structurel depuis qu'il est devenu un tremplin de promotion éditoriale. Ça sort aussi du paradoxe Letterboxd nommé plus haut en déplaçant le payeur hors de la base sociale : plus la couche lecteur reste pure, plus elle a de valeur pour le payeur. Et le cold-start est résolu deux fois — par de la curation humaine dès J1 quand la base est trop petite pour du collaboratif, et **géographiquement** : trente lecteurs d'un même quartier qui se croisent physiquement valent plus qu'un feed de trente mille inconnus dispersés. Piste à vérifier sérieusement : le statut de partenaire libraire pourrait ouvrir l'accès au FEL de Dilicom, référentiel métier exhaustif du livre français — ce qui réglerait la qualité du catalogue par la même porte que le revenu.

**Contreparties.** C'est la contrepartie la plus lourde de la liste : vendre à des libraires indépendants un par un, c'est une force de vente terrain, difficilement compatible avec une équipe de deux ou trois. Le cycle de vente est long, le panier faible, et la couverture géographique se construit ville par ville. Ligne rouge à tenir explicitement : on référence et on redirige, on ne vend pas — sinon on devient une librairie.

**Confiance.** 60 % · **Complexité.** Élevée · **Statut.** Non explorée

_Convergence : 5 cadres sur 6 — le plus fort consensus de la session._

---

### 5. La courbe d'abandon, et le produit B2B qu'elle rend possible

**Description.** Chaque page-livre affiche une courbe de survie : sur 100 personnes qui l'ont commencé, combien tiennent au chapitre 3, au chapitre 7, à la fin. L'abandon n'est plus un statut honteux à déclarer — le produit l'infère de la stagnation et propose une carte binaire (« je reprends » / « je le laisse partir »), motif d'abandon en un tap. Côté revenu, un seul produit B2B en découle et un seul : la courbe agrégée d'un titre, vendue par abonnement à l'éditeur, au traducteur, à l'agent. Strictement agrégée, seuil de k-anonymat sous lequel rien ne s'affiche, consentement explicite et par titre côté lecteur. **Aucune visibilité vendue, jamais** — pas de mise en avant payante, pas de giveaway sponsorisé.

**Axe.** 2 — Boucle de lecture solo

**Base.** `external:` le Hawking Index de Jordan Ellenberg (WSJ, 2014) reconstituait déjà où les lecteurs s'arrêtent en regardant la position du dernier passage surligné dans les Kindle Popular Highlights — la donnée est lisible et le public la trouve fascinante ; Amazon la possède et ne l'a jamais exposée. La télémétrie de playtest du jeu vidéo (courbes d'abandon par niveau) et les preview screenings d'Hollywood (cartes de score, remontage) montrent des industries entières qui mesurent ça avant de livrer. Méthodologiquement, l'abandon est une donnée censurée à droite — Kaplan-Meier, pas une note nulle. `direct:` « cause n°1 de DNF : lent et ennuyeux, 46,4 % » — une cause _positionnelle_, qui se manifeste à un endroit précis du livre et qu'aucune note globale sur 5 ne capture ; et « NetGalley : les éditeurs paient 575 $/6 mois pour un listing », donc la disposition à payer de l'édition est établie.

**Justification.** La note d'un livre n'est produite que par les survivants : c'est un biais de sélection énorme que personne ne corrige. La courbe d'abandon est une information que ni Goodreads, ni StoryGraph, ni Babelio ne peuvent produire rétroactivement — il faut avoir collecté la progression depuis le début, donc l'avance se creuse au lieu de se rattraper. Côté lecteur, c'est un argument de découverte concret (« ce livre décolle au tiers, tiens bon ») et un argument anti-culpabilité. Côté revenu, l'édition connaît les ventes mais **pas la lecture** : c'est un produit d'information réellement inédit, et il est le sous-produit direct de l'idée 1 — il ne coûte presque rien de plus à produire. Surtout, il découple le revenu du volume d'utilisateurs, ce qui est la réponse frontale au paradoxe Letterboxd. Et l'inversion de NetGalley est morale autant qu'économique : on vend de la mesure, jamais de la visibilité — c'est précisément la visibilité vendue qui a corrompu Babelio.

**Contreparties.** Publier une donnée qui peut tuer commercialement un livre crée une tension frontale avec l'édition — la même industrie à qui on veut vendre. Et vendre de la donnée de lecture agrégée, même anonymisée, est un sujet déjà politiquement chargé : des coalitions de droits civils ont interpellé le Congrès US sur la surveillance de lecture. Le risque réputationnel est réel et frotte contre la promesse anti-Amazon qui fait venir les gens. Le k-anonymat et l'opt-in par titre sont non négociables, pas des options.

**Confiance.** 65 % · **Complexité.** Moyenne · **Statut.** Non explorée

---

### 6. L'intention, pas la lecture, comme donnée principale

**Description.** Le haut du profil n'est pas la bibliothèque mais la **pile à lire ordonnée et publique**. À l'ajout, deux champs : d'où vient l'envie (une personne, une vidéo, une table de librairie, un prix, une critique) et ce qu'on en attend. Quand quelqu'un lit un livre entré chez lui via ta liste, tu es crédité nommément. Le produit publie chaque semaine un index public « ce qui monte en français », avec attribution de la cause détectée. Et il mesure le débit de la file : « tu ajoutes 63 livres/an, tu en finis 29, ton délai de sortie est de 4 ans et 3 mois — le livre ajouté aujourd'hui sera lu en 2030. »

**Axe.** 4 — Découverte & recommandation

**Base.** `reasoned:` Le seul événement **fréquent** dans la vie d'un lecteur est le désir, pas l'achèvement : 20-40 livres finis par an contre une pile de 150-300 non lus qui grossit en permanence. Tous les produits du secteur instrumentent l'achèvement et laissent le désir sans donnée — c'est exactement pourquoi leurs feeds sont vides et leurs recommandations travaillent sur 20-40 points par an et par utilisateur. Instrumenter l'envie multiplie d'un ordre de grandeur le signal disponible. `external:` le réseau Sentinelles (Inserm, 1984), où un échantillon volontaire non représentatif bat le recensement exhaustif sur la _latence_ — détecter une épidémie des semaines avant les statistiques officielles, parce qu'on remonte un signal à haute fréquence et horodaté. Loi de Little et limites de WIP du Kanban pour le calcul du débit. `direct:` « le pic de désirabilité d'un livre est piloté HORS plateforme » (BookTok, 200 milliards de vues) — la plateforme ne peut pas _créer_ le pic, mais elle peut être la première à le _mesurer_ et à en nommer la cause.

**Justification.** Ça retourne la faiblesse principale du domaine — graphe clairsemé, consommation lente — en produit éditorial hebdomadaire, récurrent et citable par la presse. Le corpus agrégé des PAL est aussi le seul signal de _demande avant achat_ qui existe : ni les ventes ni les notes ne le donnent. Le crédit d'attribution crée une monnaie de statut qui ne passe pas par la note, donc sans surface de bombardement. Et le calcul de débit inverse l'économie de l'attention du secteur : tous les concurrents optimisent l'ajout — facile, gratuit, sans valeur — alors qu'ici on optimise la sortie, ce qui rend la culpabilité actionnable au lieu de la laisser diffuse.

**Contreparties.** Deux champs obligatoires à l'ajout, c'est de la friction imposée sur le geste le plus fréquent du produit — le pari est que la donnée vaut la friction, et il peut se perdre. Le « livre ajouté aujourd'hui sera lu en 2030 » est un chiffre qui peut être vécu comme un reproche plutôt qu'un service. Et un index hebdomadaire public est un engagement éditorial récurrent, donc une charge permanente.

**Confiance.** 70 % · **Complexité.** Moyenne · **Statut.** Non explorée

---

### 7. Refuser le scalaire : classer par duels, ne jamais afficher de moyenne

**Description.** Pas d'étoiles à la saisie. En fin de lecture, trois à cinq comparaisons binaires contre des livres déjà lus de niveau voisin — « celui-ci ou celui-là ? » — d'où sort un classement personnel total et ordonné. Publiquement, une fiche livre n'affiche **aucune moyenne, aucun classement global, aucun "meilleurs livres de 2026"** : seulement des positions relatives et des personnes (« classé dans le top 5 % par 340 lecteurs qui ont aussi aimé X », « 3 personnes que tu suis l'ont fini, 2 l'ont abandonné p. 60 »).

**Axe.** 4 — Découverte & recommandation

**Base.** `external:` Beli a construit toute sa croissance sur le classement par paires plutôt que sur la note absolue, en montrant que les gens comparent bien mieux qu'ils ne notent ; TrueSkill et Glicko formalisent l'inférence d'un score latent à partir de duels ; All Our Ideas (Salganik, Princeton) fait de même sur des opinions ; Netflix a abandonné les cinq étoiles pour le pouce en 2017 parce qu'une note absolue ne se transfère pas d'un utilisateur à l'autre. `direct:` « review bombing, extorsion d'auteurs — je bombe si tu ne paies pas — ciblant disproportionnellement les auteurs marginalisés ; l'algo qui remonte les reviews les plus likées amplifie mécaniquement le toxique. »

**Justification.** Trois effets qui composent. (a) Un duel porte 5 à 10x plus d'information qu'une étoile pour un moteur de recommandation, et coûte un tap : c'est le contournement direct du plafond des 20-40 livres/an. On ne peut pas faire lire plus vite, on peut faire produire plus de signal par livre lu — et ce signal-là croît plus vite que la lecture. (b) Le bombardement n'est pas un problème de modération, c'est une conséquence arithmétique : un scalaire agrégé public est une cible optimisable par une foule coordonnée. Un agrégat sans direction dans laquelle le pousser n'a plus de payoff lisible — la modération redevient un problème de texte, pas de chiffre, et le levier d'achat éditorial disparaît avec. (c) Le classement personnel **est** l'objet d'identité partageable — l'équivalent des 4 favoris de Letterboxd, mais généré par l'usage plutôt que déclaré, donc impossible à poser et toujours à jour.

**Contreparties.** C'est le refus de la fonctionnalité la plus attendue d'un produit de notation. Plus de tri par note, plus de top 100 — et l'abandon volontaire de l'actif SEO le plus rentable du secteur, les pages « note moyenne 4,2/5 » qui captent le trafic Google générique. Question ouverte immédiate : 100 % des imports Goodreads contiennent des étoiles, qu'en fait-on ? Et il reste à démontrer qu'une fiche livre sans chiffre donne assez envie de revenir.

**Confiance.** 55 % · **Complexité.** Faible à moyenne · **Statut.** Non explorée

---

## Combinaisons remarquables

- **1 → 5 → revenu** : l'ancrage positionnel produit la courbe d'abandon, qui est le produit B2B. Une primitive, trois produits, un seul chantier.
- **2 + 1** : le manga apporte la densité et la synchronicité, l'ancrage positionnel apporte le volume de contenu par œuvre. Le tome hebdomadaire devient un objet social qui fonctionne dès le premier jour.
- **3 + 4** : le socle BnF et le partenariat libraire pourraient converger sur Dilicom/FEL — le catalogue propre et le premier revenu par la même porte.
- **6 + 5** : l'intention en amont, l'abandon en aval — ensemble, ils décrivent le cycle de vie complet d'un livre chez un lecteur, ce qu'aucun acteur ne mesure. C'est la base d'un revenu découplé du nombre d'utilisateurs.

## Rejets

| #   | Idée                                                                      | Motif                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Le catalogue rationné à 500 œuvres, entrée par parrainage                 | Le remède tue l'entrée : refuser l'import et le catalogue rend le produit inutilisable pour tout nouvel arrivant. L'argument de densité est mieux servi par le choix de niche (idée 2)                                                                                           |
| 2   | Importer l'étagère physique par photo des tranches                        | Pari technique non prouvé (reconnaissance de tranches en conditions réelles) et coûteux, précisément le type de dépense qui a tué Tome ; concurrence le levier de migration, mieux fondé                                                                                         |
| 3   | La note remplacée par un destinataire (« à qui ce livre est destiné »)    | Duplique le refus du scalaire (idée 7) avec une primitive d'évaluation moins lisible et un signal de reco plus pauvre                                                                                                                                                            |
| 4   | Pas d'étagère « lu » — aucune mémoire publique                            | Vise la même densité de feed que l'ancrage positionnel tout en supprimant la raison n°1 de créer un compte. Coût net défavorable                                                                                                                                                 |
| 5   | Pas d'app, pas de feed — un email le dimanche                             | Artefact d'inversion utile comme discipline de coût, mais son propre argument se retourne : Slice est mort faute d'app native, l'email ne produit ni le graphe ni la rétention que le sujet exige                                                                                |
| 6   | La PAL comme file Kanban avec limite dure de WIP                          | Belle mécanique mais c'est une statistique dans un produit, pas une décision structurante — conservée comme sous-mécanique de l'idée 6                                                                                                                                           |
| 7   | Zéro upload d'image, objet viral typographique                            | Discipline de coût pertinente et bien fondée (Tome), mais c'est une politique d'implémentation plutôt qu'une direction produit — à trancher au moment du design, pas ici                                                                                                         |
| 8   | Seule la citation existe, 140 signes maximum                              | Fusionne avec le rejet précédent ; en outre le renoncement au texte libre supprime le moteur mémétique même du modèle de référence sans preuve que la citation le remplace                                                                                                       |
| 9   | La liste adressée (mixtape à une personne nommée)                         | **Écartée de justesse.** Excellent argument — l'unicast n'a pas de cold-start, et ça occupe le trou laissé par la suppression des DM Goodreads. Sortie du top 7 seulement parce qu'elle n'engage aucune décision structurelle : ajoutable à tout moment sans coût de migration   |
| 10  | Le cycle synchronisé façon Daf Yomi                                       | **Écartée de justesse.** La seule mécanique connue qui fabrique un référent partagé à l'instant T pour un objet lu en asynchrone (Daf Yomi 1923, Tolstoy Together 2020). Même motif : c'est un programme éditorial, pas une décision d'architecture — donc pas urgent à trancher |
| 11  | Visibilité granulaire par livre, défaut privé (RGPD art. 9)               | **Écartée de justesse.** Argument juridique et humain solide, et le seul candidat qui traite le lecteur en période sensible. Sortie parce que c'est une exigence de conformité à honorer dans tous les cas, pas une option à départager                                          |
| 12  | Statut de lecture inféré, séance comme atome, temps comme unité canonique | Absorbées dans les idées 1 et 5 — ce sont les mécaniques de collecte que l'ancrage positionnel et la courbe d'abandon présupposent                                                                                                                                               |
| 13  | Outil de sortie Goodreads gratuit + portabilité forcée RGPD art. 20       | Absorbées comme tactique d'acquisition. Réelles et bien fondées (API fermée depuis 2020, art. 15/20 exploitable uniquement en Europe), mais c'est un canal, pas une direction produit — à rouvrir au moment du go-to-market                                                      |
| 14  | Traducteur / Expression / catalogue BnF — variantes multiples             | Fusionnées dans l'idée 3 (4 cadres convergents)                                                                                                                                                                                                                                  |
| 15  | Libraire B2B — variantes multiples                                        | Fusionnées dans l'idée 4 (5 cadres convergents)                                                                                                                                                                                                                                  |
| 16  | Ancrage positionnel — variantes multiples                                 | Fusionnées dans l'idée 1 (4 cadres convergents)                                                                                                                                                                                                                                  |

**Couverture des axes.** Aucun axe sans survivant. Axe 1 : idée 3 · axe 2 : idée 5 · axe 3 : idée 1 · axe 4 : idées 6 et 7 · axe 5 : idées 2 et 4.

## Suite

L'idéation identifie des directions ; elle ne définit pas ce qu'il faut construire. L'étape suivante est `/ce-brainstorm` sur **une** idée choisie, pour la préciser assez pour être planifiable.
