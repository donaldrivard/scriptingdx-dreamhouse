const gulp = require('gulp');
const sfdx = require('sfdx-node');
const yargs = require('yargs');
const through = require('through2');
const xml = require('gulp-xml');
const gutil = require('gulp-util');
const path = require('path');
const colors = gutil.colors;
const pad = require('pad');

//Setup CI environment from config/.ci.env
if(process.env.CI){
    require('dotenv').config({path: 'config/.ci.env'});
}



/****** HELPERS ********/

const authWeb = () => {
    return sfdx.auth.webLogin({
        setdefaultdevhubusername: true,
        setalias: 'HubOrg'
    });
}

const authJwt = () => {
    return sfdx.auth.jwtGrant({
        clientid: process.env.CONSUMERKEY,
        jwtkeyfile: 'assets/server.key',
        username: process.env.USERNAME,
        setdefaultdevhubusername: true,
        setalias: 'HubOrg'
    });
}

const webAuth = () => sfdx.auth.web()

const createScratchOrg = (definitionfile = 'config/project-scratch-def.json', setdefaultusername = true) => {    
        return sfdx.org.create({
            'definitionfile': definitionfile,
            'setdefaultusername': setdefaultusername    
        });
}

const sourcePull = () => sfdx.source.pull({quiet:false});

const pollPull = () => {
    gutil.log('Checking dev hub for changes...')
    sfdx.source.pull({quiet:false}).then(function(){
        setTimeout(pollPull, 10000);
    });
}

const sourcePush = () => sfdx.source.push({quiet: false});

const list = sfdx.org.list;

const assignPermissionSet = (permsetname = 'DreamHouse') => {
    return sfdx.user.permsetAssign({
        'permsetname': permsetname
    })
}
const importData = (plan = 'data/sample-data-plan.json') => {
    return sfdx.data.treeImport({
        'plan': plan,
        'quiet': false
    });
}

const runTests = () => {
    return sfdx.apex.testRun({
        'resultformat': 'human',
        'quiet': false
    }).then(function(results){
        if(results.summary.outcome !== 'Passed'){
            throw new gutil.PluginError('Test Run', {
                message: 'Tests are failing'
            });
        }
    });
}


const open = () =>{
    return !process.env.CI && sfdx.org.open({quiet: false});
}


const getDevHub = (list) => {
    let devHub = list && list.nonScratchOrgs && list.nonScratchOrgs.filter(function(org){
        return org.isDevHub && org.isDefaultDevHubUsername;
    });

    return devHub && devHub.length > 0 && devHub[0]
}
const getScratchOrg = (list) => {
    let defaultOrg = list.scratchOrgs && list.scratchOrgs.filter(function(org){
        if(yargs.argv.username) return (org.username == yargs.argv.username || org.alias == yargs.argv.username);
        
        return org.isDefaultUsername;
    });
    return defaultOrg && defaultOrg.length>0 && defaultOrg[0]
}

const deleteOrg = (org) => {
    if(org){
        return sfdx.org.delete({
            'targetusername': org.username,
            'quiet': false,
            'noprompt': true
        })
    }
}


const warn = (type, subtype, msg, path) => {
    let prefix = `${' '.repeat(11)}${colors.yellow.bold(`${type} warning (${colors.cyan(subtype)})`)}`;
    gutil.log(`${colors.white(path)}`);
    console.log(`${prefix} ${msg ||''}`);
}


const validateXML = (validator) => {
    let _stream = through.obj(function(file, enc, cb){
        if(file.isStream()){
             gutil.log(colors.yellow('Streams not supported for field check'));
        }
        if(file.isBuffer()){
            validator(file);
        } 
        this.push(file);
        cb();
    });
 
    _stream.on('error', (err) =>  gutil.log(colors.red('An error occured processing the file')));
 
    return _stream;
 
 }
 
/****** INIT TASKS ********/
gulp.task('init', ['create', 'init:push', 'init:assign', 'init:import'], open);

gulp.task('create', ['auth'], () => createScratchOrg());
gulp.task('init:push', ['create'], sourcePush);
gulp.task('init:assign', ['init:push'], () => assignPermissionSet());
gulp.task('init:import', ['init:assign'],  () =>  importData());

gulp.task('auth', () =>{
    return list()
    .then(getDevHub)
    .then((devHub) => {
        //if we have a dev hub, good return it;
        if(devHub) return Promise.resolve(devHub);

        //otherwise if we're CI jwtAuth, otherwise webauth a dev hub
        return process.env.CI ? authJwt() : authWeb();
    })
    .then(list);
});


/****** DEV TASKS ********/
gulp.task('assign', () => assignPermissionSet());

gulp.task('data', () => importData());

gulp.task('open', open);

gulp.task('test', runTests)

gulp.task('list', list);

gulp.task('push' , sourcePush);

gulp.task('pull', sourcePull);

gulp.task('clean', () => {
    return list()
    .then(getScratchOrg)
    .then(deleteOrg)
});

gulp.task('watch', () => {
    gulp.watch('force-app/**/*.field-meta.xml', ['check:fields'])
    gulp.watch(['force-app/**/*.cls', 'force-app/**/*.trigger'], ['push']);

    pollPull();
});

gulp.task('check:fields', () => {
    return gulp.src('**/*.field-meta.xml')
    .pipe(xml({outType: false}))
    .pipe(checkFieldDescription())
    .pipe(checkLabelNameMismatch())
})


/****** FIELD CHECKS ********/
const checkFieldDescription = () => {
    return validateXML((file) => {
        let field = JSON.parse(file.contents.toString());
        if(field.CustomField && !field.CustomField.description){
            warn('Field', `missing description`, null, path.relative('src', file.path))
        }
    });
}

const checkLabelNameMismatch = () => {
    return validateXML((file) => {
        let field = JSON.parse(file.contents.toString());
        let label = field.CustomField.label[0];
        let stdLabel = `${label.split(' ').join('_')}__c`.replace(/[\W]+/g, "");
        if(field.CustomField && stdLabel != field.CustomField.fullName){
            warn('Field', `label mismatch`, `found ${colors.yellow(field.CustomField.fullName)} should be ${colors.green(stdLabel)}`, path.relative('src', file.path))
        }
    });
}
