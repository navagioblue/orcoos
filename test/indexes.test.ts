import { describe, it } from 'mocha';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
chai.use(chaiAsPromised);

import { connect } from '../index';

import {ISale, Sale, Item, Customer, PurchaseMethod, Gender, saleSchema, customerSchema, itemSchema} from './sale';
import { ONDB_URL } from './test-utils';

describe("Indexes", () => {
    let sale: typeof Sale;
    let allExpectedSales:Array<typeof Sale> = [];

    let noOfRows = 0;
    let names = ["Al", "Bo", "Yo", "Jo", "Ax"];
    let cities = ["LA", "NY", "SF", "London", "Paris"];
    let itemNames = ["wine", "milk", "beer", "soda", "tea"];
    let tags = ["white", "green", "red"];

    describe('setup context', () => {
        it('connect', async() => {
            expect(await connect(ONDB_URL, {logLevel: 2}));
        });
        
        it('delete all', async() => {
            expect(await Sale.deleteMany());
            expect(await Sale.countDocuments()).equal(0);
        }).timeout(3000);
        
        it('save', async() => {
            sale = new Sale({
                saleDate: new Date(),
                items: [new Item({
                    name: "beer",
                    price: 8.22,
                    quantity: 4
                })],
                storeLocation: "NY"
            });
            expect(await sale.save());
            expect(await Sale.countDocuments()).equal(1);

            expect(sale._id).exist;
            expect(sale._id).to.be.a('object');
            let dbSale = await Sale.findById(sale._id);
            expect(dbSale.saleDate.getTime()).equal(sale.saleDate.getTime());
            expect(dbSale.storeLocation).equal(sale.storeLocation);
            expect(dbSale.purchaseMethod).equal(PurchaseMethod.InStore);
            expect(dbSale.items.length).equal(sale.items.length);
            expect(dbSale.items[0].name).equal(sale.items[0].name);
            expect(dbSale.items[0].price).equal(sale.items[0].price);
            expect(dbSale.items[0].quantity).equal(sale.items[0].quantity);
            expect(dbSale.customer).to.not.exist;
            allExpectedSales.push(sale);
        });
        
        it('insertMany', async () => {
            let saleCount = await Sale.countDocuments();
            let r: number;
            
            let allSales: Array<ISale> = [];

            for( let [i, name] of names.entries()) {
                r = Math.round(1000 * Math.random());
    
                let city = cities[r % cities.length];
                const sale: ISale = new Sale<ISale>({
                    saleDate: new Date(),
                    items: [new Item({
                        name: itemNames[r % itemNames.length],
                        price: r/10,
                        quantity: r % 10 + (city.length > 2 ? 10 : 0),
                        tags: tags.slice(0, i % tags.length + 1)
                    })],
                    storeLocation: city,
                    customer: {
                        gender: Object.values(Gender)[r % Object.values(Gender).length],
                        age: r % 100,
                        email: name + '@e.mail'
                    }
                });
                allSales.push(sale);
            };
        
            let res = await Sale.insertMany(allSales, {rawResult: true});
            expect(res).exist;
            expect(res.acknoledged).equal(true);
            expect(res.insertedIds).exist;
            expect(res.insertedIds).to.be.a('array');
            expect(res.insertedCount).equals(names.length);

            expect(await Sale.countDocuments()).equal(saleCount + names.length);
            noOfRows = saleCount + names.length;
            allExpectedSales = allSales;
        });
    
        it('simple query', async () => {
            let allSales = await Sale.find();
            expect(allSales).to.be.an('array');
            expect(allSales.length).equal(noOfRows);
            for await(let sale of allSales) {
                expect(sale.items[0].name).to.be.oneOf(itemNames);
                expect(sale.storeLocation).to.be.oneOf(cities);
            }
            expect(allSales.length).equal(allExpectedSales.length + 1);
        });
    });

    describe('check indexes API', () => {
        it('no indexes', async () => {
            let saleIndexes = saleSchema.indexes();
            expect(saleIndexes).is.empty;

            let customerIndexes = customerSchema.indexes();
            expect(customerIndexes).is.empty;

            let itemIndexes = itemSchema.indexes();
            expect(itemIndexes).is.empty;    
        });

        it('check no indexes', async () => {
            // stage indexes in schema
            let saleIndexes = saleSchema.indexes();
            expect(saleIndexes).is.empty;
        });
        
        it('provision indexes', async () => {
            saleSchema.index({storeLocation: 1, purchaseMethod: 1});

            let saleIndexes = saleSchema.indexes();
            expect(saleIndexes).has.lengthOf(1);

            expect(saleIndexes[0][0].storeLocation).equals(1);
            expect(saleIndexes[0][0].purchaseMethod).equals(1);
            expect(saleIndexes[0][1].background).equals(true);


            // User can provide the index name to be used in the DB
            saleSchema.index({'customer.email': 1, 'customer.satisfaction': 1}, {name: 'my_ce_cs_idx'});

            saleIndexes = saleSchema.indexes();
            expect(saleIndexes).has.lengthOf(2);

            expect(saleIndexes[1][0]['customer.email']).equals(1);
            expect(saleIndexes[1][0]['customer.satisfaction']).equals(1);
            expect(saleIndexes[1][1].background).equals(true);
            // Check user provided index name
            expect(saleIndexes[1][1].name).equals('my_ce_cs_idx');
        });

        it('create and ensure', async () => {
            // Sends createIndex commands to DB for each index declared in the schema.
            await Sale.createIndexes();

        
            // Sends createIndex commands to DB for each index declared in the schema. 
            await Sale.ensureIndexes();

            let saleIndexes = saleSchema.indexes(); 
            expect(saleIndexes).has.lengthOf(2);

            expect(saleIndexes[0][0].storeLocation).equals(1);
            expect(saleIndexes[0][0].purchaseMethod).equals(1);
            expect(saleIndexes[1][0]['customer.email']).equals(1);
            expect(saleIndexes[1][0]['customer.satisfaction']).equals(1);
            expect(saleIndexes[1][1].name).equals('my_ce_cs_idx');
        }).timeout(10000);

        it('diff', async () => {
            // Does a dry-run of Model.syncIndexes(), returning the indexes that syncIndexes() would drop and create if you were to run syncIndexes().
            const {toDrop, toCreate} = Sale.diffIndexes();
            toDrop?.forEach((i: Object) => console.log("        - toDrop " + JSON.stringify(i)));
            toCreate?.forEach((i: Object) => console.log("        - toCreate " + JSON.stringify(i)));
            if (toDrop) {
                for (let i of toDrop) {
                    console.log("        - tDr" + JSON.stringify(i));
                }
            }
            if(toCreate) {
                for (let i of toCreate) {
                    console.log("        - tCr" + JSON.stringify(i));
                }
            }
            // No indexes sent to DB yet
        });

        it('sync', async () => {
            // synchoronizes indexes, ie creates provisioned indexes, and loads from DB
            await Sale.syncIndexes();
            // this does a listIndexes and then createIndex for each that is not in the DB

            let saleIndexes = saleSchema.indexes();
            expect(saleIndexes).has.lengthOf(2);

            expect(saleIndexes[0][0].storeLocation).equals(1);
            expect(saleIndexes[0][0].purchaseMethod).equals(1);
            expect(saleIndexes[1][0]['customer.email']).equals(1);
            expect(saleIndexes[1][0]['customer.satisfaction']).equals(1);
        }).timeout(20000);

        it('clear', async () => {
            // Deletes all indexes that aren't defined in this model's schema.
            saleSchema.clearIndexes();

            let saleIndexes = saleSchema.indexes();
            expect(saleIndexes).is.empty;
        });

        it('diff2', async () => {
            // Does a dry-run of Model.syncIndexes(), returning the indexes that syncIndexes() would drop and create if you were to run syncIndexes().
            const {toDrop2, toCreate2} = Sale.diffIndexes();
            toDrop2?.forEach((i: Object) => console.log("        - toDrop2 " + JSON.stringify(i)));
            toCreate2?.forEach((i: Object) => console.log("        - toCreate2 " + JSON.stringify(i)));
        });

        it('sync2', async () => {
            // synchoronizes indexes, ie creates provisioned indexes, and loads from DB also drops the ones in DB but not in metadata
            await Sale.syncIndexes();

            let saleIndexes = saleSchema.indexes();
            expect(saleIndexes).is.empty;
        }).timeout(10000);
    });

    describe('nested arrays', () => {
        it('index on [][]', async () => {
            await saleSchema.index({"items.tags": 1});

            await Sale.createIndexes();

            // Sends createIndex commands to DB for each index declared in the schema. 
            await Sale.ensureIndexes();

            let saleIndexes = saleSchema.indexes(); 
            expect(saleIndexes).has.lengthOf(1);
            expect(saleIndexes[0][0]["items.tags"]).equals(1);
        }).timeout(10000);
        
        it('query using index on [][]', async () => {
            // Q: SELECT * FROM o_sales t WHERE ((t.kvjson."items"."tags"[] =any "red"))
            let querySales = await Sale.find({'items.tags': "red"});
            expect(querySales).to.be.an('array');
            expect(querySales.length).equal(1);
            for await (let sale of querySales) {
                expect(sale.items[0].name).to.be.oneOf(itemNames);
                expect(sale.storeLocation).to.be.oneOf(cities);
            }
            expect(querySales[0].storeLocation).equal(allExpectedSales[2].storeLocation);
            expect(querySales[0].items[0].tags[2]).equal(allExpectedSales[2].items[0].tags[2]);
            expect(querySales[0].items[0].tags[2]).equal("red");
        });
    });

    describe('test error cases', () => {
        it('index with *',async () => {
            await saleSchema.clearIndexes();
            await saleSchema.index({"items.*": 1});

            await expect(Sale.createIndexes()).to.eventually.be.rejectedWith(Error, "Orcoos does not support wildcard indexes, received: items.*");
        });

        it('index with $',async () => {
            await saleSchema.clearIndexes();
            await saleSchema.index({"$": 1});

            await expect(Sale.createIndexes()).to.eventually.be.rejectedWith(Error, "Orcoos does not support wildcard indexes, received: $");
        });

        it('index with 0',async () => {
            await saleSchema.clearIndexes();
            await saleSchema.index({"customer": 0});

            await expect(Sale.createIndexes()).to.eventually.be.rejectedWith(Error, "Orcoos supports indexes only on path values equal to 1, received: 0");
        });
    });
});