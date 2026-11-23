# Copione Lezione 10 — Dal neurone al Perceptron

Parole totali: **2575** · Scene: **19**

## 01. Reti neurali: obiettivi e paradigma (108 parole)
*10.1 Le reti neurali come strumento di ML*

In questo capitolo entriamo nelle reti neurali, partendo dall'unità più elementare fino al Perceptron e alle unità sigmoidali. Le reti neurali si studiano con due scopi distinti: modellare sistemi biologici nelle neuroscienze, oppure costruire sistemi di machine learning efficaci. Nel nostro corso conta il secondo obiettivo: ci interessano le proprietà computazionali e algoritmiche. Una rete neurale artificiale realizza una funzione h di x che apprende da esempi, approssima funzioni arbitrarie anche non lineari, gestisce rumore e dati incompleti con degradazione graduale, e tratta dati sia reali che discreti. Non è un singolo modello, ma un paradigma sub-simbolico fondato sul connessionismo: comportamenti complessi emergono dall'interazione di molte unità semplici.

## 02. Ispirazione biologica e regola di Hebb (118 parole)
*10.1.1 L'ispirazione biologica*

L'ispirazione nasce da un fatto sorprendente sul cervello umano: contiene oltre dieci miliardi di neuroni, ciascuno con decine di migliaia di connessioni. Ogni neurone impiega circa un millisecondo a rispondere, eppure riconosciamo un'immagine in un decimo di secondo, cioè in al massimo cento passi seriali. Il segreto è una computazione massicciamente parallela. I segnali entrano dai dendriti, modificano il potenziale e, superata una soglia, scatenano uno spike che viaggia lungo l'assone fino alle sinapsi, eccitatorie o inibitorie. La forza sinaptica cambia con l'apprendimento: è la plasticità, che nel modello artificiale diventa un peso. Secondo l'apprendimento hebbiano, quando gli input del neurone e le uscite correlate si ripetono, la sinapsi si rafforza e i pesi si avvicinano agli input.

## 03. Il modello matematico dell'unità (133 parole)
*10.2 Il neurone artificiale*

Passiamo ora al modello matematico del neurone artificiale, chiamato anche unità o nodo. L'unità i riceve gli ingressi: x con zero uguale a uno, che incorpora il bias, seguito dagli input x con uno, x con due, fino a x con n. Ogni connessione ha un peso libero w con i j, modificato dall'apprendimento. L'unità calcola prima l'input netto, indicato con net con i di x, come somma pesata degli ingressi: sommatoria su j di w con i j per x con j. Applica poi una funzione di attivazione f all'input netto per ottenere l'uscita o con i di x. Attenzione alla notazione degli indici: in w con i j, il primo indice i è sempre l'unità che riceve, mentre j è l'ingresso di partenza. Alcune fonti e librerie usano la convenzione opposta.

## 04. Tre funzioni di attivazione classiche (97 parole)
*10.2 Il neurone artificiale*

La scelta della funzione di attivazione f definisce il comportamento dell'unità. Tre funzioni classiche guidano tutto questo capitolo. La prima è la funzione lineare, cioè l'identità: l'uscita coincide con la somma pesata degli ingressi ed è alla base dei modelli lineari. La seconda è la funzione a soglia, o a gradino: restituisce più uno sopra lo zero e meno uno sotto lo zero, dando vita al Perceptron, cioè l'unità a soglia lineare. La terza è la funzione logistica, o sigmoide: una curva continua, liscia e differenziabile compresa tra zero e uno, che studieremo nell'ultima parte del capitolo.

## 05. McCulloch-Pitts e le porte AND, OR, NOT (125 parole)
*10.3 Reti di unità a soglia e funzioni booleane*

Il primo modello storico di neurone, proposto da McCulloch e Pitts, ha due stati: attivo, uno, e non attivo, zero. I pesi positivi rappresentano connessioni eccitatorie, quelli negativi connessioni inibitorie. Il neurone si attiva quando l'input netto, prodotto scalare tra w e x, supera zero, altrimenti restituisce zero oppure meno uno. Con questa singola unità a soglia costruiamo già le porte booleane fondamentali. Per l'AND scegliamo w uno e w due uguali a uno, e bias meno uno virgola cinque: servono entrambi gli input a uno per superare la soglia. Per l'OR basta alzare il bias a meno zero virgola cinque: è sufficiente un solo input a uno. Per il NOT poniamo peso meno uno e bias più zero virgola cinque, invertendo lo stato dell'ingresso.

## 06. Decomposizione algebrica dello XOR (119 parole)
*10.3.1 Lo XOR con due strati*

Sappiamo però che lo XOR non è linearmente separabile: nessuna singola unità a soglia può rappresentarlo. La soluzione è scomporlo in funzioni linearmente separabili. Definiamo due unità intermedie: h uno calcola l'AND tra a e b, mentre h due calcola l'OR tra a e b. Mostriamo che non h uno, AND h due, coincide esattamente con lo XOR. Per le leggi di De Morgan, la negazione di a AND b equivale a non a OR non b. Distribuendo il prodotto logico otteniamo quattro termini. Il primo termine, non a AND a, e l'ultimo, non b AND b, sono sempre falsi e si eliminano. Restano esattamente non a AND b oppure a AND non b, cioè la definizione di XOR.

## 07. Ri-rappresentazione nello strato nascosto (143 parole)
*10.3.1 Lo XOR con due strati*

Traducendo la decomposizione in architettura otteniamo una rete a due strati. Le due unità nascoste calcolano h uno, l'AND, e h due, l'OR. L'unità di uscita combina h uno con peso meno uno, h due con peso più uno e bias meno zero virgola cinque. Guardiamo cosa accade geometricamente. Nello spazio degli input i due punti positivi stanno su vertici opposti e nessuna retta li separa dai negativi. Ma nello spazio delle unità nascoste h uno e h due, entrambi gli input positivi collassano sullo stesso punto, di coordinate zero, uno. Ora la retta rossa h due uguale a h uno più zero virgola cinque separa nettamente le due classi. È l'idea fondante del representation learning: lo strato nascosto ri-rappresenta gli input. Con due livelli di unità a soglia si rappresenta qualunque funzione booleana, ma manca ancora un algoritmo per apprendere i pesi.

## 08. Due famiglie: Adaline contro Perceptron (112 parole)
*10.4 Apprendere con una singola unità*

Finora i pesi delle unità erano fissati a mano. Come li apprendiamo dai dati, partendo da una singola unità? Esistono due grandi famiglie di metodi. La prima è Adaline, Adaptive Linear Neuron: durante l'addestramento l'unità resta lineare e si usa l'algoritmo LMS, in forma diretta o con discesa del gradiente. Serve per regressione e, aggiungendo una soglia in uscita, per classificazione; soprattutto, è l'approccio che si estenderà ai Multi-Layer Perceptron. La seconda famiglia è il Perceptron vero e proprio: durante l'addestramento l'unità è già non lineare con soglia e serve solo per la classificazione. Per costruire un classificatore lineare abbiamo quindi tre algoritmi: LMS diretto, LMS a gradiente e l'algoritmo del Perceptron.

## 09. L'algoritmo on-line del Perceptron (147 parole)
*10.4.1 L'algoritmo del Perceptron*

L'algoritmo del Perceptron è online e mira a minimizzare il numero di esempi classificati male, cercando un vettore di pesi w tale che il segno di w trasposto x coincida con il target d, che vale più uno oppure meno uno. Si inizializzano i pesi a zero o a piccoli valori casuali e si fissa un learning rate eta tra zero e uno. Si scorrono gli esempi uno alla volta finché un'intera epoca passa senza errori. Se l'uscita coincide con d, i pesi non cambiano. Se invece c'è un errore, si aggiorna w aggiungendo eta per d per x. Attenzione al caso sul confine, w trasposto x uguale a zero: per convenzione si conta sempre come errore, cioè serve d per w trasposto x strettamente positivo. La stessa regola si riscrive anche come w più un mezzo eta, per la differenza tra d e l'uscita, per x.

## 10. Geometria dell'aggiornamento e due letture (144 parole)
*10.4.1 L'algoritmo del Perceptron*

Vediamo il significato geometrico dell'aggiornamento. Il vettore dei pesi w punta sempre verso il semipiano positivo, perpendicolare al confine lineare. Supponiamo che l'esempio p uno abbia target più uno, ma si trovi dal lato sbagliato del confine rosso. Sommando il vettore eta per d per x a w, il nuovo vettore dei pesi ruota verso p uno e il nuovo confine blu ora lo classifica correttamente. Se invece un esempio negativo fosse classificato male, w verrebbe allontanato da esso. La regola ha due letture: come somma di eta per d per x è apprendimento hebbiano. Riscritta con delta uguale a d meno l'uscita, assorbendo il fattore un mezzo nel learning rate, è una delta rule di correzione dell'errore: la modifica di un peso è proporzionale al prodotto tra errore e ingresso. Qui delta è subito misurabile, cosa che non varrà più negli strati nascosti.

## 11. Teorema di convergenza: enunciato e Passo 1 (140 parole)
*10.5 Il teorema di convergenza del Perceptron*

Il Perceptron rappresenta confini lineari, ma riesce sempre a impararli? La risposta è data dal teorema di convergenza del Perceptron. Se il problema è linearmente separabile, l'algoritmo converge in un numero finito di passi classificando bene tutti gli esempi, da qualunque punto di partenza, anche se la soluzione finale non è unica. Se il problema non è separabile, invece, l'algoritmo può entrare in cicli senza stabilizzarsi. Cominciamo la dimostrazione dal Passo uno: ridurci a esempi tutti positivi. Esiste una soluzione w stella con margine minimo alfa strettamente positivo. Se definiamo x primo con i, uguale a d con i per x con i, ribaltando gli esempi negativi, poiché d con i al quadrato vale uno, sia la condizione di soluzione sia la condizione di errore e l'aggiornamento dei pesi restano identici. Basta quindi dimostrare il teorema con soli esempi positivi.

## 12. Passo 2 e l'idea dei due limiti (164 parole)
*10.5 Il teorema di convergenza del Perceptron*

Nel Passo due fissiamo w di zero uguale al vettore nullo, learning rate eta uguale a uno e definiamo beta come il massimo della norma quadra degli esempi. Partendo da zero, porre eta uguale a uno non limita la generalità: un altro eta riscala tutti i pesi per la stessa costante positiva, senza cambiare i segni né la sequenza degli errori. Il caso con pesi iniziali non nulli richiede solo di adattare i due limiti. Con soli esempi positivi, a ogni errore sommiamo l'esempio sbagliato, quindi dopo q errori il vettore w di q è la somma dei q esempi che hanno causato errore. Ecco l'idea chiave della dimostrazione: imprigionare la norma quadra di w di q tra un limite inferiore che cresce come q al quadrato, la parabola blu, e un limite superiore che cresce linearmente come q, la retta rossa. Poiché una parabola supera sempre una retta, oltre q massimo i due limiti diventano incompatibili: gli errori sono quindi in numero finito.

## 13. Dimostrazione: Passi 3, 4 e 5 e significato del bound (174 parole)
*10.5 Il teorema di convergenza del Perceptron*

Ricaviamo ora i due limiti. Nel Passo tre, moltiplicando w stella per w di q, ogni termine vale almeno alfa, quindi il prodotto scalare è almeno q per alfa. Applicando la disuguaglianza di Cauchy-Schwarz otteniamo il limite inferiore: la norma quadra di w di q è maggiore o uguale al quadrato di q per alfa, diviso la norma quadra di w stella. Nel Passo quattro sviluppiamo il quadrato della norma di w al passo q meno uno, più l'esempio sbagliato al passo q. Poiché quell'esempio era classificato male, il doppio prodotto centrale è minore o uguale a zero e possiamo eliminarlo, ottenendo per induzione norma quadra di w di q minore o uguale a q per beta. Nel Passo cinque combiniamo le due disuguaglianze: q è limitato da beta per la norma quadra di w stella, diviso alfa al quadrato. Dopo l'ultimo errore l'algoritmo compie un'epoca senza errori e si ferma. Più le classi sono vicine all'iperpiano, più alfa è piccolo e più passi servono: è il concetto di margine che ritroveremo nelle SVM.

## 14. Perché l'LMS può sbagliare su dati separabili (121 parole)
*10.6 Perceptron contro LMS*

Confrontiamo ora il Perceptron con l'LMS. Le due regole di aggiornamento hanno la stessa forma, ma nell'LMS il segnale delta usa l'uscita lineare w trasposto x, mentre nel Perceptron usa l'uscita con soglia, cioè il segno. Questa differenza ha una conseguenza sorprendente: l'LMS può classificare male anche problemi perfettamente separabili. Guarda il grafico sui dati reali delle note. C'è un gruppo di punti positivi blu molto lontano dal confine. Anche se sono già classificati bene, il loro w trasposto x è molto più grande di uno e genera un enorme errore quadratico, che tira la retta arancione dell'LMS causando quattro errori di classificazione. Il Perceptron invece non tocca gli esempi già corretti: entrambe le sue rette separano perfettamente le due classi.

## 15. Tabella comparativa e svolta verso il gradiente (109 parole)
*10.6 Perceptron contro LMS*

Riassumiamo il confronto tra Perceptron e LMS in quattro punti chiave. Primo, l'obiettivo: il Perceptron minimizza le classificazioni errate tramite il segno, mentre l'LMS minimizza l'errore quadratico sull'uscita lineare. Secondo, sui problemi separabili il Perceptron converge in un numero finito di passi a zero errori, mentre l'LMS converge solo asintoticamente. Terzo, sui problemi non separabili il Perceptron non converge, mentre l'LMS converge comunque, pur potendo commettere errori anche quando i dati sono separabili. Quarto punto, il più decisivo: il Perceptron è difficile da estendere a reti di unità, mentre l'LMS si estende alle reti grazie al gradiente. Per costruire reti neurali multistrato ci servono quindi funzioni di attivazione differenziabili.

## 16. Sigmoide logistica, tangente iperbolica e altre attivazioni (167 parole)
*10.7 Unità sigmoidali*

Ecco perché introduciamo le unità sigmoidali. La funzione logistica è una funzione a schiacciamento, squashing, con valori continui tra zero e uno: uno diviso uno più e elevato a meno a x, dove a è la pendenza. È una versione liscia e differenziabile del gradino: per a che tende a zero diventa una retta quasi piatta, per a che tende a infinito diventa una soglia netta, e vicino a zero è quasi lineare. La versione simmetrica tra meno uno e più uno è la tangente iperbolica: due f sigma di x meno uno, uguale alla tangente iperbolica di a x mezzi. In classificazione la soglia naturale è zero virgola cinque per la logistica e zero per la tangente iperbolica, ma si può spostare con curve ROC o inserire una zona di rifiuto. In pratica esistono anche altre attivazioni: le RBF gaussiane, la softmax per uscite multiple, i neuroni stocastici, la ReLU massimo tra zero e x, scelta standard nei modelli profondi, e la sua versione liscia softplus.

## 17. La derivata elegante della sigmoide (151 parole)
*10.7.1 Derivate*

Perché la funzione a gradino blocca la discesa del gradiente? Perché la sua derivata non è definita in zero ed è nulla ovunque altrove. Le sigmoidi risolvono il problema con una proprietà algebrica comodissima. Scrivendo la logistica come uno più e elevato a meno x, il tutto elevato a meno uno, e applicando la regola della catena, otteniamo e alla meno x diviso il quadrato di uno più e alla meno x. Spezzando la frazione in due fattori si scopre che f primo sigma di x vale esattamente f sigma di x per uno meno f sigma di x, con un fattore a davanti per pendenza generica. Analogamente, la derivata della tangente iperbolica è uno meno tangente iperbolica al quadrato. La derivata si calcola direttamente dall'uscita della funzione stessa. Come mostra il grafico, f primo raggiunge il massimo in zero, dove vale zero virgola venticinque, e tende a zero nelle code.

## 18. Gradiente sull'unità sigmoidale e saturazione (180 parole)
*10.7.2 LMS con un'unità sigmoidale*

Applichiamo ora la discesa del gradiente a un'unità sigmoidale minimizzando l'errore quadratico tra d con p e f sigma di x con p trasposto w. Per un esempio p, la regola della catena scompone la derivata parziale dell'errore rispetto al peso w con j in tre fattori: derivata di E rispetto all'uscita o, cioè meno due per d meno o; derivata di o rispetto all'input netto, cioè f primo sigma dell'input netto; e derivata dell'input netto rispetto a w con j, che è l'ingresso x con p j. Questa derivata risponde a una domanda precisa: quanto una variazione del peso influenza la variazione dell'errore. La regola di aggiornamento mantiene la stessa forma dell'LMS lineare, ma con un nuovo delta: d meno o, moltiplicato per f primo sigma dell'input netto. Vicino a zero f primo è grande, ma nelle zone sature f primo è quasi nullo e i pesi si muovono lentissimamente. Per evitare saturazione prematura si parte da pesi piccoli; d'altro canto, su esempi già classificati con decisione la correzione si annulla, creando un ponte naturale tra LMS e Perceptron.

## 19. Punti chiave e domande di autoverifica (123 parole)
*Sintesi e verifica*

Chiudiamo il capitolo fissando i cinque punti essenziali. Primo: il neurone calcola f della somma pesata degli input, dove w con i j va da j verso i. Secondo: una singola unità a soglia rappresenta AND, OR e NOT, mentre lo XOR richiede due strati grazie alla ri-rappresentazione nello strato nascosto. Terzo: il Perceptron aggiorna i pesi solo sugli errori e converge in al più beta per la norma quadra di w stella, diviso alfa al quadrato, se i dati sono separabili. Quarto: l'LMS può sbagliare su problemi separabili, ma si estende alle reti col gradiente. Quinto: la sigmoide ha derivata f sigma per uno meno f sigma e porta alla delta rule differenziabile, base del prossimo capitolo su Multi-Layer Perceptron e backpropagation.
