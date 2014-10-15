var express = require('express');
var session = require('express-session');
var app = express();
var _ = require('underscore')._;
var pg = require('pg');
var productsJson;
var passport = require('passport');
var ForceDotComStrategy = require('passport-forcedotcom').Strategy;
var moment = require('moment');
var uuid = require('node-uuid');
var RedisStore = require('connect-redis')(express.session);

var userJson;

console.log("DB URL: "+process.env.DATABASE_URL);

//Session Setup
app.use(express.cookieParser());

app.use(session({
    store: new RedisStore({
	    host: process.env.REDISURL,
	    port: 11042,
	    pass: process.env.REDISPW
  	}),
    secret: process.env.SESSION_SECRET
}));

//Passport Setup
passport.use(new ForceDotComStrategy({
  clientID: process.env.CONSUMERKEY,
  clientSecret: process.env.CONSUMERSECRET,
  scope: ['id','chatter_api'],
  callbackURL: process.env.CALLBACKURL,
  display:'touch',
  authorizationURL: 'https://gersic-developer-edition.na15.force.com/baconforce/services/oauth2/authorize'
}, function verify(token, refreshToken, profile, done) {
  console.log(profile);
  return done(null, profile);
}));

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});


app.use(express.bodyParser());
app.use(passport.initialize());
app.use(passport.session());

//just a dummy API for Express demo purposes
app.get('/sayhello', function(req,res) {
	res.send('hello world');		
});


//API: get product list from database
app.get('/products', function(req,res) {

	pg.connect(process.env.DATABASE_URL, function(err, client, done) {
		if(err) {
			return console.error('error fetching client from pool', err);	
			}
		client.query('SELECT * FROM salesforce.product2', function(err, result) {
			if(err) return console.error(err);
			productsJson = result.rows;

			res.send(productsJson);						
			done();

		});	 			
	});

});

//API: authenticate
app.get('/auth/forcedotcom', passport.authenticate('forcedotcom'));

//API: auth callback
app.get('/auth/forcedotcom/callback',
  passport.authenticate('forcedotcom', { failureRedirect: '/error' }),
  function(req, res){
  	console.log(req);
  	req.session.userJson = req.user._raw;
    //res.render("index",checkSession(req));
    //res.send(req.user);	
    res.redirect('/');
  }
);

//API: send user info by field
app.get('/user/:field?', function(req,res){
	if(req.session.userJson == null) {
		res.send(null);
	}
	else if(req.params.field == null){
		res.send(req.session.userJson);
	}
	else {
		res.send(req.session.userJson[req.params.field]);	
	}
});

//API: Place an Order
app.post('/order', function(req,res){
	console.log("ORDER");
	console.log(req.body);
	var orderJson = req.body;
	var opportunityExternalId = uuid.v1();

	newOpportunity(orderJson,opportunityExternalId,function(result){
		console.log(result);
		getPricebook(function(priceBookEntriesByProductId){
			createOpportunityLineItems(opportunityExternalId,orderJson,priceBookEntriesByProductId,function(result){
				res.send({"status":"success"});	
			},function(err){
				logErrorWithResponse(err,res)
			});

		},function(err) {
			logErrorWithResponse(err,res);
		});
		
	},function(err){
		logErrorWithResponse(err,res);
	});
});

app.use("/api",express.static(__dirname + "/public/api"));
app.use("/components",express.static(__dirname + "/bower_components"));
app.use("/images",express.static(__dirname + "/public/images"));
app.use("/product-service",express.static(__dirname + "/public/product-service"));
app.use("/user-service",express.static(__dirname + "/public/user-service"));
app.use("/order-service",express.static(__dirname + "/public/order-service"));
app.use(express.static(__dirname + "/public/app"));


app.listen(process.env.PORT);

/**
 * log any errors
 **/
function logErrorWithResponse(error,response) {
	console.log("ERROR: ");
	console.log(error);
	response.send({"response":error});	
}

/**
 * Create the new opportunity
 **/
function newOpportunity(orderJson,opportunityExternalId,success,error) {
	pg.connect(process.env.DATABASE_URL, function(err, client, done) {
		if(err) {
			return console.error('error fetching client from pool', err);	
		}
		client.query('INSERT INTO salesforce.opportunity (name,closedate,stagename,externalid__c,ownerid) VALUES ($1,$2,$3,$4,$5) RETURNING id',[
				'Order for '+orderJson.userName,
				moment().format("YYYY-MM-DD"),
				'Closed Won',
				opportunityExternalId,
				orderJson.userId
				], function(err, result) {
			if(err) {
				error(err);
			}
			else {
				success(result)
				done();
			}
		});	 			
	});	
}

/**
 * Get the pricebook data, and return an object with product ids as keys
 **/
function getPricebook(success,error) {
	pg.connect(process.env.DATABASE_URL, function(err, client, done) {
		if(err) {
			return console.error('error fetching client from pool', err);	
		}
		client.query('SELECT sfid,product2id,unitprice FROM salesforce.pricebookentry', function(err, result) {
			if(err) {
				error(err);
			}
			else {
				
				var priceBookEntriesByProductId = {};
				_.each(result.rows, function (val, key) {  
    				priceBookEntriesByProductId[val.product2id] = val;
				});

				console.log(priceBookEntriesByProductId);

				success(priceBookEntriesByProductId)
				done();
			}
		});	 			
	});	
}

/**
 * Create all of the line items for this opportunity (referenced by external id because it's being created in postgres prior to sync)
 **/
function createOpportunityLineItems(opportunityExternalId,orderJson,priceBookEntriesByProductId,success,error){
	console.log("OPPTY LINE ITEMS");
	_.each(_.keys(orderJson.items), function(key,i){
		newOpportunityLineItem(opportunityExternalId,priceBookEntriesByProductId[key].sfid,orderJson.items[key],priceBookEntriesByProductId[key].unitprice,function(result){
			success(result);
		},function(err){
			error(err);
		});
	});
}

/**
 * Create a single new opportunity line item using the Opportunity external id
 **/
function newOpportunityLineItem(opportunityExternalId,pricebookentryId,quantity,unitPrice,success,error) {
	console.log("NEW OPPTY LINE ITEM");
	console.log(opportunityExternalId);
	console.log(pricebookentryId);
	console.log(quantity);
	console.log(unitPrice);


	pg.connect(process.env.DATABASE_URL, function(err, client, done) {
		if(err) {
			return console.error('error fetching client from pool', err);	
		}
		client.query('INSERT INTO salesforce.opportunitylineitem (opportunity__externalid__c,pricebookentryid,quantity,unitprice) VALUES ($1,$2,$3,$4) RETURNING id',
			[opportunityExternalId,
			pricebookentryId,
			quantity,
			unitPrice], function(err, result) {
			if(err) {
				error(err);
			}
			else {
				success(result)
				done();
			}
		});	 			
	});	
}