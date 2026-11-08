// Stand-in for Canopy's HcRange.cs: holds a harvester's awakeRange and sleepRange (its saved fields,
// 20 and 35 m unless they say otherwise) for the harvester's own stand-in. Does nothing itself.
Tickable.register("HcRange", class extends Tickable {
    get awakeRange() { return this.fields.awakeRange ?? 20; }
    get sleepRange() { return this.fields.sleepRange ?? 35; }
});
