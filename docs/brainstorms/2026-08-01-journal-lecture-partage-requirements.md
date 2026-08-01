---
date: 2026-08-01
topic: journal-lecture-partage
---

# Journal de lecture partagé — exigences

## Résumé

Un journal de lecture partagé par un groupe fermé d'une vingtaine d'amis : étagères, notes, avis, profils et fil d'activité. Par-dessus, une couche « lecture en cours » de première classe — qui lit quoi et où il en est — qui fait vivre le fil entre deux livres finis et sert de garde-fou anti-spoiler. Et un catalogue parcourable par sujet, auteur et série, pour découvrir des livres que personne du groupe n'a lus.

---

## Contexte

Vingt personnes qui lisent beaucoup, lisent souvent les mêmes livres, et se les recommandent entre elles. Aujourd'hui tout se passe de vive voix. Il n'y a aucun outil, aucun contournement construit, aucun groupe de discussion dédié — donc rien qui se conserve. Les avis existent au moment où ils sont prononcés puis disparaissent, et quand quelqu'un veut savoir ce que le groupe a pensé d'un livre, il n'y a nulle part où regarder.

Le manque déclaré est triple et il faut tenir les trois bouts : un endroit où **regrouper les avis et les notes** du groupe, un moyen de **se recommander** des livres entre membres, et de quoi **découvrir des livres que personne du groupe n'a lus** — sans quoi le produit se referme sur ce que vingt personnes connaissent déjà et cesse d'apporter quoi que ce soit au bout de quelques mois.

Une conséquence du fait que vingt personnes lisent les mêmes livres : elles ne les lisent pas au même rythme. Le spoiler n'est pas un risque théorique importé d'un autre produit, il est mécanique dès que trois personnes sont sur le même roman à trois endroits différents. Aucun produit du domaine ne le traite correctement — chez Goodreads le tag spoiler couvre les avis mais pas les mises à jour de statut, et le trou n'est résolu ni chez StoryGraph ni ailleurs.

---

## Décisions clés

**L'avancement est le battement du produit, pas la fin de livre.** Un lecteur finit 20 à 40 livres par an ; à vingt personnes cela fait environ 600 événements annuels, soit moins de deux par jour. C'est assez pour qu'un fil vive, mais tout juste, et cela laisse le produit muet pendant les semaines où quelqu'un est au milieu d'un pavé. L'état « en cours » dure des semaines : en faire un objet visible et actualisable multiplie la matière disponible et rend le produit intéressant à ouvrir un jour où personne n'a rien terminé.

**Le masquage anti-spoiler est une propriété du stockage, pas une case à cocher.** Chaque contenu textuel porte la position de son auteur au moment de l'écriture, et un lecteur ne voit que ce qui a été écrit à une position inférieure ou égale à la sienne. Un tag déclaratif se rouvre à chaque nouvelle surface ajoutée au produit ; une inégalité portée par la donnée tient toute seule.

**Les notes restent toujours visibles ; seuls les textes sont masqués.** Sinon la page d'un livre qu'on envisage de lire est vide, ce qui casse la moitié « recommandation » du besoin. La note agrégée du groupe est précisément ce qu'on vient chercher avant de commencer un livre ; l'avis détaillé est ce qu'on vient chercher après. La conséquence vaut aussi pour un livre qui n'est sur aucune étagère : le lecteur y est traité comme s'il était au début, donc les textes sont masqués et les notes ne le sont pas. C'est le moment où le spoiler coûte le plus cher — quelqu'un qui hésite est quelqu'un qui va peut-être lire le livre.

**La position est stockée en proportion de l'œuvre, pas en numéro de page.** Un membre saisit une page ou un pourcentage selon ce qu'il a sous les yeux ; le produit convertit via la pagination de l'édition qu'il lit. C'est ce qui permet à trois personnes sur trois éditions différentes de se comparer. La pagination des éditions est la métadonnée la plus sale du domaine — les sources publiques ont des comptes de pages à zéro — donc les membres doivent pouvoir la corriger.

**Le modèle distingue l'Œuvre de l'Édition dès le départ.** Un membre logge une édition précise ; les notes et les avis s'agrègent au niveau de l'œuvre. Fusionner les deux est la racine du catalogue sale de Goodreads, et le séparer après coup est une migration douloureuse alors que le faire d'emblée ne coûte presque rien.

**Aucun avis tiers n'est importé, jamais.** La découverte hors du groupe passe par les métadonnées du catalogue, pas par des avis récupérés ailleurs. Trois raisons qui vont dans le même sens. Juridiquement, récupérer les avis de Goodreads ou Babelio contrevient à leurs conditions d'utilisation, ces textes appartiennent à leurs auteurs, et ce sont des données personnelles de personnes qui n'ont rien consenti — un produit hébergé en Europe ne peut pas assainir ça après coup. Structurellement, un avis venu d'ailleurs n'a pas de position dans le livre, donc il traverse le masquage anti-spoiler sans que le produit puisse le retenir : il faudrait soit l'exempter, soit inventer une position fictive. Et sur le fond, l'intérêt du produit est de regrouper les avis de vingt personnes qu'on connaît ; les noyer dans des milliers d'avis d'inconnus les rend moins lisibles, pas plus.

**La découverte s'appuie sur les sujets du catalogue.** Un membre doit pouvoir tomber sur un livre que personne du groupe n'a lu. Le levier est la métadonnée déjà présente dans les sources ouvertes — genres, sujets, auteurs, séries — mieux exploitée que pour la simple recherche par titre. C'est la fondation ; la note agrégée d'une source tierce, les nouveautés et prix, et les suggestions calculées sur les listes du groupe s'y greffent plus tard sans la remettre en cause.

**Notes en étoiles, pas en duels.** L'idéation proposait un classement par comparaisons binaires ; le besoin exprimé est de noter, pas d'être classé. La forme éprouvée l'emporte.

**Accès sur invitation.** Pas d'inscription libre, pas de découverte d'inconnus. Le groupe est l'unité, et sa fermeture est ce qui rend inutiles la modération, la lutte contre le review bombing et la plupart des mécaniques de confiance.

**Web responsive d'abord.** Une application native est ce qui manquait aux produits du domaine qui sont morts, mais elle n'est pas ce qui met le produit entre les mains de vingt personnes le plus vite. Le web mobile est le compromis assumé, à réévaluer une fois l'usage réel observé.

---

## Acteurs

- A1. **Membre** — lit, tient son journal, note, écrit des avis, déclare son avancement, consulte le journal des autres.
- A2. **Membre invitant** — un membre qui fait entrer quelqu'un dans le groupe. Ce n'est pas un rôle d'administration : tout membre peut inviter.

---

## Exigences

**Journal personnel**

- R1. Un membre place un livre sur l'une de trois étagères : à lire, en cours, lu.
- R2. Un membre note un livre sur une échelle d'étoiles avec demi-étoiles.
- R3. Un membre écrit un avis en texte libre sur un livre, indépendamment de la note — l'un n'exige pas l'autre.
- R4. L'abandon est un état distinct de « lu » et de « en cours ». Il n'exige ni note ni avis, et n'est pas présenté comme un échec.
- R5. Le journal d'un membre est consultable comme une page : ce qu'il lit, ce qu'il a lu, ce qu'il a abandonné, ses notes, ses avis.

**Lecture en cours et avancement**

- R6. Un membre déclare son avancement sur un livre en cours, en page ou en pourcentage selon le format qu'il a sous les yeux.
- R7. Déclarer son avancement est facultatif pour consulter le produit, mais exigé au moment de publier un avis ou un commentaire sur un livre non terminé.
- R8. La page d'un livre montre qui, dans le groupe, le lit en ce moment et où il en est.
- R9. Les avancements successifs d'un membre sur un livre forment un historique visible sur son journal.

**Masquage anti-spoiler**

- R10. Tout avis et tout commentaire portent la position de leur auteur au moment de l'écriture.
- R11. Un membre ne voit pas, par défaut, les contenus textuels écrits à une position supérieure à la sienne sur ce livre.
- R12. La position implicite est nulle pour un livre qui n'est pas encore commencé, et totale pour un livre marqué lu ou abandonné.
- R13. Un contenu masqué reste visible en tant qu'objet — on sait qu'il existe et qui l'a écrit — et se révèle par un geste explicite du lecteur.
- R14. Les notes et leur agrégat ne sont jamais masqués.

**Le groupe**

- R15. L'accès se fait sur invitation par un membre existant ; il n'y a pas d'inscription libre.
- R16. Un fil d'activité présente les événements du groupe : mises en rayon, avancements, notes, avis, abandons.
- R17. Un membre ajoute un livre à son étagère « à lire » depuis le journal d'un autre membre, et la provenance est conservée et affichée sur l'entrée.
- R18. Quand un membre lit un livre dont la provenance est un autre membre, celui-ci en est informé.

**Catalogue et fiches livre**

- R19. La recherche porte sur le titre, l'auteur et l'ISBN, et la fiche est créée depuis une source de données externe.
- R20. Le produit distingue l'Œuvre de l'Édition. Un membre logge une édition ; notes et avis s'agrègent au niveau de l'œuvre.
- R21. Un membre corrige ou complète une fiche quand la source externe est fausse ou incomplète, en particulier la pagination.

**Découverte hors du groupe**

- R22. Un membre parcourt le catalogue sans partir d'un titre : par genre, par sujet, par auteur, par série.
- R23. Depuis la fiche d'un livre, un membre atteint l'auteur, la série et les sujets rattachés, et de là d'autres livres — y compris des livres que personne du groupe n'a lus.
- R24. Un livre découvert par le catalogue s'ajoute à l'étagère « à lire » comme les autres, avec une provenance « catalogue » distincte de la provenance « membre » de R17.

---

## Parcours principaux

- F1. **Consigner un livre terminé** — le geste central du besoin exprimé.
  - **Déclencheur :** un membre finit un livre.
  - **Acteurs :** A1
  - **Étapes :** il cherche le livre, choisit son édition, le passe en « lu », pose une note, écrit un avis s'il en a un.
  - **Résultat :** l'avis est conservé et visible par le groupe ; la note entre dans l'agrégat de l'œuvre ; l'événement apparaît au fil.
  - **Couvre :** R1, R2, R3, R19, R20

- F2. **Publier au milieu d'une lecture** — le masquage en action.
  - **Déclencheur :** un membre veut réagir à un passage sans avoir fini le livre.
  - **Acteurs :** A1
  - **Étapes :** il déclare où il en est, écrit son commentaire, qui est enregistré avec cette position. Un autre membre moins avancé sur le même livre voit qu'un contenu existe mais pas son texte.
  - **Résultat :** la conversation existe pendant la lecture sans gâcher celle des autres.
  - **Couvre :** R6, R7, R10, R11, R13

- F3. **Reprendre une recommandation** — la moitié « recommander » du besoin.
  - **Déclencheur :** un membre voit sur le journal d'un ami un livre qui l'intéresse.
  - **Acteurs :** A1
  - **Étapes :** il l'ajoute à son étagère « à lire » depuis cette page ; la provenance est enregistrée. Plus tard il le lit ; l'ami est informé.
  - **Résultat :** la chaîne de transmission d'un livre dans le groupe devient visible.
  - **Couvre :** R17, R18

---

## Exemples d'acceptation

- AE1. **Couvre R11.** Étant donné un membre à 30 % d'un roman, quand un autre membre a publié un commentaire à 70 %, alors le texte de ce commentaire ne s'affiche pas.
- AE2. **Couvre R12.** Étant donné un membre qui a marqué un livre comme lu, quand il consulte la page de ce livre, alors tous les contenus sont visibles sans geste de révélation.
- AE3. **Couvre R12, R14.** Étant donné un membre qui n'a jamais mis un livre sur une étagère, quand il consulte sa page, alors la note agrégée du groupe s'affiche mais les textes des avis sont masqués.
- AE4. **Couvre R7.** Étant donné un membre avec un livre en cours et aucun avancement déclaré, quand il tente de publier un commentaire, alors le produit lui demande d'abord où il en est.
- AE5. **Couvre R13.** Étant donné un contenu masqué, quand le membre le révèle explicitement, alors il reste révélé pour ce membre et cette révélation ne change rien pour les autres.
- AE6. **Couvre R20.** Étant donné deux membres ayant lu deux éditions différentes de la même œuvre, quand on consulte la page de l'œuvre, alors les deux notes sont agrégées ensemble.

---

## Critères de réussite

- Les vingt membres s'inscrivent et au moins la moitié consigne un livre dans le premier mois.
- Un membre qui veut savoir ce que le groupe a pensé d'un livre trouve la réponse sans demander à quelqu'un.
- L'avancement est déclaré assez souvent pour que la page d'un livre en cours de lecture collective ne soit pas vide — c'est l'hypothèse porteuse du produit, et c'est le premier chiffre à regarder.
- Une part notable des livres mis en « à lire » vient du catalogue et non d'un autre membre — si tout ce qui entre vient déjà du groupe, la découverte n'a rien apporté.
- Personne ne se fait gâcher un livre par le produit.

---

## Limites de portée

**Reporté**

- Le fil positionnel complet, où tout contenu est ancré et où le fil d'un livre se parcourt dans le livre plutôt que dans le temps. Les fondations posées ici — position portée par chaque contenu, échelle proportionnelle — le rendent ajoutable sans migration.
- Le format audio. Le groupe lit surtout en papier, ce qui rend ce report tenable sans exclure personne du masquage ni de la présence. Le modèle proportionnel l'accueillera le jour venu — un horodatage rapporté à une durée — mais rien n'est fait pour lui dans cette version.
- Une application native, à réévaluer une fois l'usage réel observé.
- L'import d'une bibliothèque existante depuis un autre service : personne dans le groupe n'en utilise.
- Trois compléments de découverte, retenus mais reportés derrière R22-R24 : la note agrégée d'une source tierce quand personne du groupe n'a lu le livre (à conditionner à une vérification de la couverture francophone des API concernées) ; les nouveautés, prix et sélections (les prix sont dans Wikidata, la rentrée littéraire n'est nulle part sous forme exploitable, donc coût de maintenance à la main) ; les suggestions calculées sur les listes du groupe (aucune dépendance externe, mais quasi muettes tant que le corpus est petit).

**Hors identité du produit**

- L'import ou la récupération d'avis écrits ailleurs. Ce n'est pas un report : c'est exclu par construction, pour des raisons juridiques et de cohérence du masquage.

- Tout le volet économique de l'idéation : partenariats libraires, mesure vendue aux éditeurs, index de tendances, affiliation. Le produit ne se monétise pas.
- L'ouverture au public, la découverte d'inconnus, les classements globaux. Le groupe fermé n'est pas une étape avant l'ouverture, c'est la forme du produit.
- Le club de lecture à calendrier imposé, où le groupe lit la même chose en même temps. Séduisant pour vingt personnes qui lisent déjà les mêmes livres, mais il ne sert pas la moitié « recommandation » et il fait dépendre le produit d'une coordination sociale qu'il ne contrôle pas.

---

## Dépendances et hypothèses

- **Source de catalogue externe.** Le produit ne saisit pas ses fiches à la main. Les sources publiques ont une couverture francophone inégale et une qualité de pagination médiocre, ce qui est précisément la donnée dont dépend le masquage — d'où R21.
- **La découverte dépend de la richesse des sujets, pas seulement des titres.** R22 et R23 ne valent que ce que valent les vedettes-matière et les liens auteur/série de la source retenue. C'est un critère de choix de la source au même titre que la pagination, et il tire vers les données ouvertes de la BnF, dont le dépôt légal couvre l'édition française et dont l'indexation matière est nettement plus fine que celle des sources anglophones généralistes.
- **Hypothèse porteuse : le groupe déclarera son avancement.** Toute la couche « lecture en cours » en dépend, et avec elle le masquage anti-spoiler et la vivacité du fil. Si elle ne tient pas, le produit dégénère en journal partagé simple, ce qui reste utile mais n'est plus ce qui a été choisi.
- **Hypothèse : le recouvrement de lectures est réel.** Le masquage et la présence sociale n'ont de sens que si plusieurs membres sont sur les mêmes livres à des moments proches. C'est affirmé par le groupe, pas encore observé.
- **Le besoin est déclaré, pas observé.** Personne n'a jamais essayé d'outil ni construit de contournement — les conversations se tiennent de vive voix. C'est l'incertitude principale du projet : on ne sait pas si un outil sera adopté ou si la conversation orale suffit déjà.

---

## Questions ouvertes

Rien ne bloque la planification.

**À trancher pendant la planification**

- Le choix de la source de catalogue et la stratégie de cache des couvertures, arbitré sur trois critères : couverture francophone, fiabilité de la pagination, finesse de l'indexation matière.
- La forme du parcours par sujet : une taxonomie fermée et lisible construite à partir des vedettes-matière, ou l'exposition directe des sujets bruts de la source, qui sont nombreux et inégaux.
- La forme du fil : un fil chronologique unique du groupe, ou une entrée par livre.
- Ce qui se passe quand un membre relit un livre déjà consigné.

---

## Sources

- `docs/ideation/2026-08-01-letterboxd-livres-ideation.md` — l'idéation dont ce document est issu, notamment l'idée n°1 (ancrage positionnel) et son recadrage au périmètre « moi et mes amis ».
- Art antérieur sur l'ancrage de contenu à une position : SoundCloud ancre au timecode, Genius à la ligne, Wattpad au paragraphe. Aucun produit de catalogage de livres ne l'a fait — tous ont repris le modèle de l'avis après coup, hérité du cinéma.
- Le trou du tag spoiler chez Goodreads (les mises à jour de statut y échappent), non résolu chez StoryGraph.
- La distinction Œuvre / Expression / Manifestation vient de FRBR ; MusicBrainz et Discogs résolvent le même problème d'objet à identités multiples.
